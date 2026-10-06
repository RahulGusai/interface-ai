import asyncio
from .repositories import identifier,now
from .storage import staged_file

class Evidence:
    def __init__(self,repo,storage):self.repo,self.storage=repo,storage
    async def persist(self,run_id,event,assets,staging):
        confirmed=[];paths=[];failed=False
        for asset in assets:
            key=f'v1/runs/{run_id}/{identifier()}.png'
            try:
                path=staged_file(staging,asset['staged_path']);paths.append(path)
                info=await asyncio.wait_for(asyncio.to_thread(self.storage.put_png,key,path,asset['sha256']),20)
                if info['width']!=asset['width'] or info['height']!=asset['height']:raise ValueError('Image dimensions mismatch')
                confirmed.append({**info,'asset_id':key.split('/')[-1][:-4],'kind':asset['kind'],'captured_at':asset['captured_at'],'label':event['type'],'result':'failed' if event['payload'].get('verdict')=='failed' else None,'detail':None})
            except Exception:failed=True;break
        payload={**event['payload']}
        if assets:payload['evidence']={'status':'partial' if failed and confirmed else 'upload_failed' if failed else 'available',**({'code':'STORAGE_UPLOAD_FAILED'} if failed else {})}
        elif event['type'] in ('tool_finished','target_resolution_finished','target_reference_captured'):payload['evidence']={'status':'unavailable','reason':'capture_denied_or_failed'}
        try:row=await asyncio.to_thread(self.repo.event,run_id,event['type'],payload,event.get('step_id'),confirmed)
        except Exception:
            for item in confirmed:
                try:await asyncio.wait_for(asyncio.to_thread(self.storage.remove,item['object_key']),3)
                except Exception:pass
            raise
        for path in paths:path.unlink(missing_ok=True)
        return {'event_sequence':row['sequence'],'continue':not failed}
