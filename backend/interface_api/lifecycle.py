import asyncio,copy,hashlib,shutil
from .repositories import identifier,now
from .artifact_validation import canonical,digest,validate_definition,validate_inputs
from .storage import staged_file
from .errors import ApiError
from .reads import Reads
from .maintenance import TERMINAL

def outcome(kind,code,message,outputs=None,stage=None,step=None,dispatch='completed',expected=None,observed=None):
    return {'kind':kind,'code':code,'message':message,'outputs':outputs,'failure_stage':stage,'step_id':step,'expected':expected,'observed':observed,'dispatch_state':dispatch}

class Lifecycle:
    def __init__(self,repo,worker,storage):self.repo,self.worker,self.storage=repo,worker,storage;self.reads=Reads(repo)
    async def execute(self,ident):
        try:
            message=await self.worker.execute_raw(ident)
            if message is None:
                stopped=await asyncio.to_thread(self.repo.get,'runs','run_id',ident)
                if stopped['purpose']=='validation':
                    draft=await asyncio.to_thread(self.repo.get,'artifacts','artifact_id',stopped['pinned_artifact_id'])
                    if draft['state']!='published':await asyncio.to_thread(self.validation_failed,draft,ident,stopped.get('result') or {'outcome':outcome('hard_failure','VALIDATION_REPLAY_FAILED','Validation stopped',stage='finalization')})
                return
            run=await asyncio.to_thread(self.repo.get,'runs','run_id',ident);runtime=message['runtime_result']
            if run['kind']=='discovery':
                if runtime['status']=='awaiting_artifact_design':
                    await asyncio.to_thread(self.repo.transition,ident,'awaiting_finalization',None,runtime)
                    draft=await self.prepare_draft(ident,message.get('discovery_proposal'))
                    validation=await asyncio.to_thread(self.start_validation,draft['artifact_id'],run['inputs'],None,None,True)
                    await self.execute(validation['run_id'])
                elif runtime['status']=='business_outcome':
                    await asyncio.to_thread(self.repo.transition,ident,'completed',{'outcome':outcome('expected_outcome',runtime.get('proposedOutcome',{}).get('outcome_code','BUSINESS_OUTCOME'),runtime['summary'],runtime.get('outputs'))},runtime)
                else:
                    code='RUNTIME_STOPPED_REQUIRES_HUMAN' if runtime['status']=='needs_intervention' else runtime['status'].upper()
                    await asyncio.to_thread(self.repo.transition,ident,'failed',{'outcome':outcome('hard_failure',code,runtime['summary'],stage='execution',dispatch='uncertain')},runtime)
            else:
                success=runtime['status']=='success';expected=runtime['status']=='expected_outcome'
                result={'outcome':outcome('success' if success else 'expected_outcome' if expected else 'hard_failure',runtime['code'],runtime['message'],runtime.get('outputs'),runtime.get('failure_stage'),runtime.get('step_id'),runtime.get('dispatch_state','uncertain'),runtime.get('expected'),runtime.get('observed'))}
                if run['purpose']=='validation' and success:result['validated_definition_sha256']=run['artifact_definition_sha256']
                await asyncio.to_thread(self.repo.transition,ident,'completed' if success or expected else 'failed',result,runtime)
                if run['purpose']=='validation':
                    artifact=await asyncio.to_thread(self.repo.get,'artifacts','artifact_id',run['pinned_artifact_id'])
                    if artifact['state']!='published':
                        if success:await asyncio.to_thread(self.publish_validated,artifact['source_run_id'],artifact['artifact_id'],ident)
                        else:await asyncio.to_thread(self.validation_failed,artifact,ident,result)
        except Exception:
            await self.worker.fail(ident,'ARTIFACT_FINALIZATION_FAILED','finalization')
            with self.repo.db.transaction() as c:c.execute("UPDATE artifacts SET state='validation_failed' WHERE source_run_id=? AND state!='published'",(ident,))
            row=await asyncio.to_thread(self.repo.get,'runs','run_id',ident)
            if row['purpose']=='validation':
                artifact=await asyncio.to_thread(self.repo.get,'artifacts','artifact_id',row['pinned_artifact_id'])
                if artifact['state']!='published':await asyncio.to_thread(self.validation_failed,artifact,ident,{'outcome':outcome('hard_failure','VALIDATION_REPLAY_FAILED','Validation or publication could not complete',stage='finalization')})
        finally:
            row=await asyncio.to_thread(self.repo.get,'runs','run_id',ident)
            if row['kind']=='discovery' and row['status'] in TERMINAL:shutil.rmtree(self.worker.settings.database_path.parent/'staging'/ident,ignore_errors=True)
    async def prepare_draft(self,source_id,proposal):
        source=self.repo.get('runs','run_id',source_id)
        if source['status']!='awaiting_finalization' or not isinstance(proposal,dict) or proposal.get('proposal_version')!=1:raise ValueError('Invalid discovery proposal')
        if set(proposal)!={'proposal_version','capability_selection','parameter_values','observed_outputs','definition','reference_assets'}:raise ValueError('Invalid proposal fields')
        definition=copy.deepcopy(proposal['definition']);validate_definition(definition)
        dep=source['deployment_snapshot'];selection=proposal['capability_selection'];mode=selection.get('mode')
        if mode not in ('reuse','new') or not selection.get('reason'):raise ValueError('Invalid capability selection')
        contract=self.repo.get('capabilities','capability_id',selection['capability_id']) if mode=='reuse' else selection
        if mode=='new' and (not selection.get('name') or not selection.get('description')):raise ValueError('Invalid capability name')
        if canonical(contract['input_schema'])!=canonical(definition['input_schema']) or canonical(contract['output_schema'])!=canonical(definition['output_schema']):raise ValueError('CAPABILITY_SCHEMA_DRIFT')
        values=validate_inputs(definition['input_schema'],proposal['parameter_values']);outputs=validate_inputs(definition['output_schema'],proposal['observed_outputs'])
        if any(k not in values or canonical(v)!=canonical(values[k]) for k,v in source['inputs'].items()):raise ValueError('EXPLICIT_INPUT_CONFLICT')
        if not self.reads.compatible({'definition':definition},dep):raise ValueError('ARTIFACT_INCOMPATIBLE')
        artifact_id=identifier();stamp=now();assets=[];handles={}
        staging=self.worker.settings.database_path.parent/'staging'/source_id
        events=self.repo.rows('run_events','run_id=?',(source_id,),'sequence ASC')
        for ref in proposal['reference_assets']:
            handle=ref['asset_handle']
            if handle in handles:raise ValueError('Duplicate crop handle')
            event=next((e for e in events if e['type']=='target_reference_captured' and e['payload'].get('call_id')==ref['source_call_id'] and e['payload'].get('asset_handle')==handle and e['payload'].get('sha256')==ref['sha256']),None)
            if event is None:raise ValueError('Crop provenance missing')
            for key in ('crop_rect','relative_point','capture_context'):
                if canonical(event['payload']['reference'][key])!=canonical(ref[key]):raise ValueError('Crop provenance mismatch')
            evidence=self.repo.rows('evidence_assets','run_id=? AND event_sequence=?',(source_id,event['sequence']),'captured_at ASC')
            if not evidence:raise ValueError('Pre-action evidence unavailable')
            asset_id=identifier();key=f'v1/artifacts/{artifact_id}/{asset_id}.png';path=staged_file(staging,ref['staged_path'])
            info=await asyncio.wait_for(asyncio.to_thread(self.storage.put_png,key,path,ref['sha256']),20)
            if info['width']!=ref['crop_rect']['width'] or info['height']!=ref['crop_rect']['height']:raise ValueError('Crop dimensions mismatch')
            assets.append({**info,'asset_id':asset_id,'artifact_id':artifact_id,'kind':'reference_crop','source_run_id':source_id,'source_event_sequence':event['sequence'],'source_evidence_asset_id':evidence[0]['asset_id'],'crop_rect_json':canonical(ref['crop_rect']),'relative_point_json':canonical(ref['relative_point']),'capture_context_json':canonical(ref['capture_context']),'created_at':stamp});handles[handle]=asset_id
        def normalize(value):
            if isinstance(value,list):
                for v in value:normalize(v)
            elif isinstance(value,dict):
                if value.get('kind')=='visual':
                    handle=value['asset_id'];ref=next((r for r in proposal['reference_assets'] if r['asset_handle']==handle),None)
                    if ref is None or ref['sha256']!=value['sha256']:raise ValueError('Unknown visual reference')
                    value['asset_id']=handles[handle]
                for v in value.values():normalize(v)
        normalize(definition);validate_definition(definition)
        with self.repo.db.transaction() as c:
            current=self.repo.get('runs','run_id',source_id,c)
            if current['status']!='awaiting_finalization':raise ApiError(409,'RUN_STATUS_CONFLICT','Discovery stopped during finalization')
            self.repo.insert(c,'artifacts',{'artifact_id':artifact_id,'source_run_id':source_id,'capability_id':selection['capability_id'] if mode=='reuse' else None,'version':None,'schema_version':1,'tool_contract_version':1,'state':'draft','definition_json':canonical(definition),'capability_proposal_json':canonical(selection),'definition_sha256':digest(definition),'created_at':stamp})
            for asset in assets:self.repo.insert(c,'artifact_assets',asset)
            c.execute('UPDATE runs SET inputs_json=? WHERE run_id=?',(canonical(values),source_id))
            self.repo.event(source_id,'inputs_extracted',{'inputs':values},conn=c);self.repo.event(source_id,'artifact_draft_created',{'artifact_id':artifact_id,'definition_sha256':digest(definition),'observed_outputs':outputs,'goal_verified':True},conn=c)
        return self.repo.get('artifacts','artifact_id',artifact_id)
    def start_validation(self,artifact_id,inputs,key=None,request_hash=None,automatic=False,conn=None):
        if conn is None:
            with self.repo.db.transaction() as c:return self.start_validation(artifact_id,inputs,key,request_hash,automatic,c)
        artifact=self.repo.get('artifacts','artifact_id',artifact_id,conn);source=self.repo.get('runs','run_id',artifact['source_run_id'],conn)
        dep=source['deployment_snapshot'] if automatic else self.repo.get('app_deployments','app_deployment_id',source['app_deployment_id'],conn)
        if not self.reads.compatible(artifact,dep):raise ApiError(409,'ARTIFACT_INCOMPATIBLE','Deployment metadata differs')
        values=validate_inputs(artifact['definition']['input_schema'],source['inputs'] if automatic else inputs)
        if artifact['state']!='published':
            if source['status'] not in ('awaiting_finalization','failed','interrupted'):raise ApiError(409,'VALIDATION_IN_PROGRESS','Draft cannot currently be validated')
            self.repo.transition(source['run_id'],'validating',conn=conn)
            conn.execute("UPDATE artifacts SET state='validating' WHERE artifact_id=?",(artifact_id,))
        run=self.repo.new_run(conn,dep,'replay','validation',artifact,inputs=values,selection='validation',parent=source['run_id'],key=key,request_hash=request_hash)
        self.repo.event(source['run_id'],'validation_started',{'validation_run_id':run['run_id'],'artifact_id':artifact_id},conn=conn)
        return run
    def validation_failed(self,artifact,validation_id,result):
        with self.repo.db.transaction() as c:
            c.execute("UPDATE artifacts SET state='validation_failed' WHERE artifact_id=? AND state!='published'",(artifact['artifact_id'],))
            source=self.repo.get('runs','run_id',artifact['source_run_id'],c)
            if source['status']=='validating':self.repo.transition(source['run_id'],'failed',{'outcome':{**result.get('outcome',{}),'kind':'hard_failure','code':'VALIDATION_REPLAY_FAILED','failure_stage':'finalization'},'validation_run_id':validation_id},conn=c)
            elif source['status']=='cancelling':self.repo.transition(source['run_id'],'cancelled',{'stop_reason':{'code':'USER_CANCELLED','dispatch_state':'uncertain'}},conn=c)
    def publish_validated(self,source_id,artifact_id,validation_id):
        with self.repo.db.transaction() as c:
            artifact=self.repo.get('artifacts','artifact_id',artifact_id,c);source=self.repo.get('runs','run_id',source_id,c)
            if artifact['state']=='published':return (source['result'] or {}).get('publication')
            validation=self.repo.get('runs','run_id',validation_id,c);dep=self.repo.get('app_deployments','app_deployment_id',source['app_deployment_id'],c)
            if artifact['source_run_id']!=source_id or source['status']!='validating' or validation['status']!='completed' or validation['purpose']!='validation' or validation['parent_run_id']!=source_id or validation['pinned_artifact_id']!=artifact_id or validation['artifact_definition_sha256']!=artifact['definition_sha256'] or (validation['result'] or {}).get('validated_definition_sha256')!=artifact['definition_sha256'] or (validation['result'] or {}).get('outcome',{}).get('kind')!='success' or dep['config_version']!=validation['deployment_snapshot']['config_version']:raise ApiError(409,'PUBLICATION_CONFLICT','Validation no longer permits publication')
            if digest(artifact['definition'])!=artifact['definition_sha256']:raise ValueError('Frozen hash mismatch')
            selected=artifact['capability_proposal'];cap_id=artifact['capability_id'];definition=artifact['definition']
            if selected['mode']=='new':
                cap_id=identifier();self.repo.insert(c,'capabilities',{'capability_id':cap_id,'name':selected['name'],'description':selected['description'],'input_schema_json':canonical(definition['input_schema']),'output_schema_json':canonical(definition['output_schema']),'created_at':now()})
            else:
                contract=self.repo.get('capabilities','capability_id',cap_id,c)
                if any(canonical(contract[k])!=canonical(definition[k]) for k in ('input_schema','output_schema')):raise ValueError('Capability schema drift')
            version=c.execute('SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE capability_id=?',(cap_id,)).fetchone()[0]
            c.execute("UPDATE artifacts SET state='published',capability_id=?,version=?,published_at=?,validated_run_id=? WHERE artifact_id=?",(cap_id,version,now(),validation_id,artifact_id))
            history=self.repo.rows('capability_bindings','app_deployment_id=? AND capability_id=?',(dep['app_deployment_id'],cap_id),conn=c)
            binding_id=None;action='unchanged'
            if not history:
                binding=self.new_binding(c,dep,cap_id,artifact_id,validation_id,1,'Initial validated publication');binding_id=binding['binding_id'];action='initial_ready'
                self.repo.event(source_id,'binding_activated',{'binding_id':binding_id,'binding_version':1},conn=c)
            publication={'binding_action':action,'binding_id':binding_id}
            result={'outcome':outcome('success','GOAL_ACHIEVED','Discovery artifact published after deterministic validation',validation['result']['outcome']['outputs']),'publication':publication}
            c.execute('UPDATE runs SET finalized_artifact_id=?,capability_id=? WHERE run_id=?',(artifact_id,cap_id,source_id))
            self.repo.event(source_id,'artifact_published',{'artifact_id':artifact_id,'capability_id':cap_id,'version':version,**publication},conn=c)
            self.repo.transition(source_id,'completed',result,conn=c)
            return publication
    def new_binding(self,c,dep,capability,artifact,validation,version,note):
        data={'binding_id':identifier(),'app_deployment_id':dep['app_deployment_id'],'capability_id':capability,'artifact_id':artifact,'binding_version':version,'state':'ready','deployment_config_version':dep['config_version'],'validation_run_id':validation,'selection_note':note,'created_at':now(),'retired_at':None};self.repo.insert(c,'capability_bindings',data);return data
    def activate(self,deployment_id,capability_id,artifact_id,validation_id,expected,note):
        with self.repo.db.transaction() as c:
            dep=self.repo.get('app_deployments','app_deployment_id',deployment_id,c);artifact=self.repo.get('artifacts','artifact_id',artifact_id,c);source=self.repo.get('runs','run_id',artifact['source_run_id'],c)
            if source['app_deployment_id']!=deployment_id:raise ApiError(409,'CROSS_DEPLOYMENT_VALIDATION_DEFERRED','Only source deployment activation is supported')
            if artifact['state']!='published' or artifact['capability_id']!=capability_id:raise ApiError(409,'ARTIFACT_INCOMPATIBLE','Artifact is not published for this capability')
            eligibility=self.reads.eligibility(artifact,dep)
            if eligibility['state']!='ready' or eligibility['validation_run_id']!=validation_id:raise ApiError(409,'VALIDATION_REQUIRED','Latest current-configuration success is required')
            rows=self.repo.rows('capability_bindings','app_deployment_id=? AND capability_id=?',(deployment_id,capability_id),'binding_version DESC',c);active=next((r for r in rows if r['state']=='ready'),None)
            if expected!=(active['binding_version'] if active else None):raise ApiError(409,'BINDING_VERSION_CONFLICT','Active binding changed')
            if active:c.execute("UPDATE capability_bindings SET state='retired',retired_at=? WHERE binding_id=?",(now(),active['binding_id']))
            data=self.new_binding(c,dep,capability_id,artifact_id,validation_id,rows[0]['binding_version']+1 if rows else 1,note)
            self.repo.event(validation_id,'binding_activated',{'binding_id':data['binding_id'],'binding_version':data['binding_version']},conn=c)
            return data
