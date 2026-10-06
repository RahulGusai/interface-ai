import asyncio,shutil,os
from .evidence import Evidence
from .repositories import now
from .artifact_validation import canonical
from .maintenance import sweep_staging,TERMINAL

class Worker:
    def __init__(self,repo,settings,storage,runner):
        self.repo,self.settings,self.storage,self.runner=repo,settings,storage,runner
        self.queue=asyncio.Queue(maxsize=16);self.admission=asyncio.Lock();self.accepting=True;self.task=None;self.active=None;self.cancel_signal=None;self.lifecycle=None
    def startup_reconcile(self,code='PROCESS_RESTARTED'):
        with self.repo.db.transaction() as c:
            rows=self.repo.rows('runs',"status NOT IN ('completed','failed','cancelled','interrupted')",conn=c)
            for row in rows:
                self.repo.transition(row['run_id'],'interrupted',{'stop_reason':{'code':code,'dispatch_state':'uncertain' if row['status']!='queued' else 'not_dispatched'}},conn=c)
            c.execute("UPDATE artifacts SET state='validation_failed' WHERE state IN ('draft','validating')")
        sweep_staging(self.repo,self.settings.database_path.parent/'staging')
        return len(rows)
    async def start(self):
        await asyncio.to_thread(self.startup_reconcile);self.task=asyncio.create_task(self.loop())
    async def loop(self):
        while True:
            ident=await self.queue.get()
            try:
                row=await asyncio.to_thread(self.repo.get,'runs','run_id',ident)
                if row['status']=='queued':
                    self.active=ident;self.cancel_signal=asyncio.Event()
                    if self.lifecycle:await self.lifecycle.execute(ident)
                    else:await self.execute_raw(ident)
            except asyncio.CancelledError:raise
            except Exception:
                await self.fail(ident,'RUNNER_EXECUTION_FAILED')
            finally:self.active=None;self.cancel_signal=None;self.queue.task_done()
    async def fail(self,ident,code,stage='execution'):
        row=await asyncio.to_thread(self.repo.get,'runs','run_id',ident)
        if row['status'] in TERMINAL:return
        if row['status']=='cancelling':await asyncio.to_thread(self.repo.transition,ident,'cancelled',{'stop_reason':{'code':'USER_CANCELLED','dispatch_state':'uncertain'}});return
        await asyncio.to_thread(self.repo.transition,ident,'failed',{'outcome':{'kind':'hard_failure','code':code,'message':'Execution stopped; inspect recorded events','outputs':None,'failure_stage':stage,'step_id':None,'expected':None,'observed':None,'dispatch_state':'uncertain'}})
    async def execute_raw(self,ident):
        row=await asyncio.to_thread(self.repo.transition,ident,'running');staging=self.settings.database_path.parent/'staging'/ident
        staging.mkdir(parents=True,exist_ok=True,mode=0o700)
        assets=[];artifact=None
        try:
            if row['pinned_artifact_id']:
                artifact=await asyncio.to_thread(self.repo.get,'artifacts','artifact_id',row['pinned_artifact_id'])
                for asset in await asyncio.to_thread(self.repo.rows,'artifact_assets','artifact_id=?',(artifact['artifact_id'],),'created_at ASC'):
                    data=await asyncio.wait_for(asyncio.to_thread(self.storage.get_png,asset['object_key'],asset['sha256']),20)
                    name=asset['asset_id']+'.png';path=staging/name;path.write_bytes(data);path.chmod(0o600);assets.append({'asset_id':asset['asset_id'],'staged_path':name,'sha256':asset['sha256']})
            command={'protocol_version':1,'type':'start','run_id':ident,'mode':row['kind'],'deployment':row['deployment_snapshot'],'task':row['task'],'inputs':row['inputs'],'capability_catalog':await asyncio.to_thread(self.repo.rows,'capabilities'),'artifact':artifact,'assets':assets,'staging_directory':str(staging),'runtime':{'headless':self.settings.headless,'max_tool_calls':self.settings.max_tool_calls,'allow_writes':self.settings.allow_writes,'allow_screenshots':self.settings.allow_screenshots,'path_prefix':self.settings.path_prefix}}
            sink=Evidence(self.repo,self.storage)
            async def persist(message):
                if message['type']=='event':return await sink.persist(ident,message['event'],message['assets'],staging)
                event=await asyncio.to_thread(self.repo.event,ident,'runner_completed',{'runtime_result':message['runtime_result'],'discovery_proposal':message.get('discovery_proposal')})
                return {'event_sequence':event['sequence'],'continue':True}
            result=await self.runner.run(command,persist,self.cancel_signal)
            if self.cancel_signal.is_set():
                current=await asyncio.to_thread(self.repo.get,'runs','run_id',ident)
                if current['status']=='cancelling':await asyncio.to_thread(self.repo.transition,ident,'cancelled',{'stop_reason':{'code':'USER_CANCELLED','dispatch_state':result['runtime_result'].get('dispatch_state','uncertain')}})
                return None
            return result
        except Exception as exc:
            code='STORAGE_UPLOAD_FAILED' if str(exc)=='STORAGE_UPLOAD_FAILED' else 'RUNNER_EXITED' if str(exc)=='RUNNER_EXITED' else 'RUNNER_PROTOCOL_ERROR'
            await self.fail(ident,code,'storage' if code=='STORAGE_UPLOAD_FAILED' else 'execution');return None
        finally:
            # Proposal crop files survive until lifecycle imports them. Terminal cleanup happens there.
            if artifact:shutil.rmtree(staging,ignore_errors=True)
    async def cancel(self,ident):
        def mark():
            with self.repo.db.transaction() as c:
                row=self.repo.get('runs','run_id',ident,c)
                if row['status'] in ('cancelled','cancelling'):return row
                if row['status'] in TERMINAL:
                    from .errors import ApiError
                    raise ApiError(409,'RUN_NOT_CANCELLABLE','Run is already terminal')
                status='cancelled' if row['status']=='queued' else 'cancelling'
                result={'stop_reason':{'code':'USER_CANCELLED','dispatch_state':'not_dispatched'}} if status=='cancelled' else None
                self.repo.transition(ident,status,result,conn=c)
                children=self.repo.rows('runs',"parent_run_id=? AND status IN ('queued','running')",(ident,),conn=c)
                for child in children:self.repo.transition(child['run_id'],'cancelled' if child['status']=='queued' else 'cancelling',conn=c)
                return self.repo.get('runs','run_id',ident,c)
        row=await asyncio.to_thread(mark)
        if self.active==ident and self.cancel_signal:self.cancel_signal.set()
        return row
    async def shutdown(self):
        self.accepting=False
        if self.cancel_signal:self.cancel_signal.set()
        if self.task:
            try:await asyncio.wait_for(self.queue.join(),15)
            except asyncio.TimeoutError:pass
            self.task.cancel();await asyncio.gather(self.task,return_exceptions=True)
        await asyncio.to_thread(self.startup_reconcile,'SERVICE_SHUTDOWN')
