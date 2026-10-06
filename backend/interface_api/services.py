import asyncio
from uuid import UUID
from .errors import ApiError
from .artifact_validation import digest,validate_inputs
from .reads import Reads

class Services:
    def __init__(self,repo,worker,lifecycle,storage,storage_ready=True,runner_ready=True):
        self.repo,self.worker,self.lifecycle,self.storage=repo,worker,lifecycle,storage
        self.storage_ready,self.runner_ready=storage_ready,runner_ready;self.reads=Reads(repo)
    def contract_inputs(self,schema,inputs):
        try:return validate_inputs(schema,inputs)
        except Exception:raise ApiError(422,'INPUT_CONTRACT_INVALID','Inputs do not match the pinned capability contract',{'fields':[{'path':'inputs','code':'schema','message':'Check required fields, types and formats'}]})
    async def admit(self,key,request,capability_id=None,validation_artifact=None):
        try:key=str(UUID(key))
        except Exception:raise ApiError(422,'IDEMPOTENCY_KEY_INVALID','Idempotency-Key must be a UUID')
        payload={**request,'capability_id':capability_id,'validation_artifact_id':validation_artifact};request_hash=digest(payload)
        async with self.worker.admission:
            def existing():
                rows=self.repo.rows('runs','idempotency_key=?',(key,))
                if rows:
                    if rows[0]['request_sha256']!=request_hash:raise ApiError(409,'IDEMPOTENCY_CONFLICT','Key was used for a different request')
                    return rows[0]
            previous=await asyncio.to_thread(existing)
            if previous:return await asyncio.to_thread(self.reads.run,previous)
            if not self.worker.accepting or not self.runner_ready:raise ApiError(503,'WORKER_UNAVAILABLE','Execution worker is unavailable',retryable=True)
            if not self.storage_ready:raise ApiError(503,'STORAGE_UNAVAILABLE','Private storage is unavailable',retryable=True)
            if request.get('kind')=='discovery' and not (self.worker.settings.openrouter_api_key and self.worker.settings.openrouter_model):raise ApiError(503,'MODEL_UNAVAILABLE','Discovery model is not configured')
            if self.worker.queue.full():raise ApiError(503,'QUEUE_FULL','Pending run queue is full',retryable=True)
            def create():
                with self.repo.db.transaction() as c:
                    dep=self.repo.get('app_deployments','app_deployment_id',request['app_deployment_id'],c)
                    inputs=request.get('inputs',{});binding=None;artifact=None;selection='discovery'
                    if validation_artifact:
                        artifact=self.repo.get('artifacts','artifact_id',validation_artifact,c);source=self.repo.get('runs','run_id',artifact['source_run_id'],c)
                        if source['app_deployment_id']!=dep['app_deployment_id']:raise ApiError(409,'CROSS_DEPLOYMENT_VALIDATION_DEFERRED','Only source deployment validation is supported')
                        inputs=self.contract_inputs(artifact['definition']['input_schema'],inputs)
                        return self.lifecycle.start_validation(validation_artifact,inputs,key,request_hash,conn=c)
                    if capability_id:
                        self.repo.get('capabilities','capability_id',capability_id,c)
                        candidates=self.repo.rows('capability_bindings',"app_deployment_id=? AND capability_id=? AND state='ready'",(dep['app_deployment_id'],capability_id),conn=c)
                        if not candidates:raise ApiError(409,'DISCOVERY_NEEDED','No active binding exists for this deployment')
                        binding=candidates[0];artifact=self.repo.get('artifacts','artifact_id',binding['artifact_id'],c);selection='binding'
                    elif request['kind']=='replay':
                        artifact=self.repo.get('artifacts','artifact_id',request['artifact_id'],c);selection='explicit_artifact'
                        candidates=self.repo.rows('capability_bindings',"app_deployment_id=? AND artifact_id=? AND state='ready'",(dep['app_deployment_id'],artifact['artifact_id']),conn=c)
                        binding=candidates[0] if candidates else None
                    if artifact:
                        if artifact['state']!='published':raise ApiError(409,'ARTIFACT_NOT_PUBLISHED','Replay requires a published artifact')
                        readiness=self.reads.eligibility(artifact,dep)
                        if readiness['state']!='ready':raise ApiError(409,'VALIDATION_REQUIRED',readiness['reason'])
                        inputs=self.contract_inputs(artifact['definition']['input_schema'],inputs)
                    return self.repo.new_run(c,dep,'replay' if artifact else 'discovery',artifact=artifact,binding=binding,task=request.get('task'),inputs=inputs,selection=selection,key=key,request_hash=request_hash)
            run=await asyncio.to_thread(create)
            try:self.worker.queue.put_nowait(run['run_id'])
            except asyncio.QueueFull:
                await self.worker.fail(run['run_id'],'QUEUE_ADMISSION_FAILED');raise ApiError(503,'QUEUE_ADMISSION_FAILED','Run could not enter the worker queue')
            return await asyncio.to_thread(self.reads.run,run)
    async def signed(self,table,asset_id):
        row=await asyncio.to_thread(self.repo.get,table,'asset_id',asset_id)
        if not self.storage_ready:raise ApiError(503,'ASSET_UNAVAILABLE','Asset storage is unavailable',retryable=True)
        try:signed=await asyncio.wait_for(asyncio.to_thread(self.storage.sign_get,row['object_key']),20)
        except Exception:raise ApiError(503,'ASSET_UNAVAILABLE','Asset content is unavailable',retryable=True)
        return {**signed,**{k:row[k] for k in ('asset_id','sha256','width','height','mime_type')}}
