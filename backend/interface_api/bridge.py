import asyncio,json,os,signal
from pathlib import Path
from .storage import staged_file
MAX_LINE=1024*1024

def validate_message(value,run_id,sequence):
    if not isinstance(value,dict) or value.get('protocol_version')!=1 or value.get('run_id')!=run_id:raise ValueError('Invalid protocol identity')
    kind=value.get('type')
    if kind not in ('ready','event','completed'):raise ValueError('Unknown protocol message')
    if kind=='ready':
        if set(value)!={'protocol_version','type','run_id'}:raise ValueError('Invalid ready')
        return value
    if value.get('message_seq')!=sequence:raise ValueError('Invalid message order')
    if kind=='event':
        event=value.get('event');assets=value.get('assets')
        if not isinstance(event,dict) or set(event)!={'type','step_id','payload'} or not isinstance(event['type'],str) or not isinstance(event['payload'],dict) or not isinstance(assets,list):raise ValueError('Invalid event')
        for asset in assets:
            if set(asset)!={'staged_path','kind','sha256','width','height','captured_at'} or asset['kind'] not in ('post_tool_screenshot','target_resolution_screenshot','observation_screenshot'):raise ValueError('Invalid asset')
            staged_file(Path('/tmp'),asset['staged_path'])
            if not isinstance(asset['sha256'],str) or len(asset['sha256'])!=64 or any(c not in 'abcdef0123456789' for c in asset['sha256']) or type(asset['width']) is not int or type(asset['height']) is not int or not 0<asset['width']<=1280 or not 0<asset['height']<=800:raise ValueError('Invalid asset metadata')
    elif not isinstance(value.get('runtime_result'),dict):raise ValueError('Invalid completion')
    return value

class NodeRunner:
    def __init__(self,settings):self.settings=settings
    async def probe(self):
        try:
            proc=await asyncio.create_subprocess_exec(self.settings.node_bin,'--import','tsx','--input-type=module','-e',"import{chromium}from'playwright';import{existsSync}from'node:fs';const v=Number(process.versions.node.split('.')[0]);process.exit((v===22||v>=24)&&existsSync(chromium.executablePath())?0:1)",cwd=self.settings.repo_root,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
            try:return await asyncio.wait_for(proc.wait(),5)==0
            except asyncio.TimeoutError:proc.kill();await proc.wait();return False
        except Exception:return False
    async def run(self,command,sink,cancel):
        s=self.settings
        env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR','PLAYWRIGHT_BROWSERS_PATH','LANG','NODE_EXTRA_CA_CERTS')}
        if s.openrouter_api_key:env['OPENROUTER_API_KEY']=s.openrouter_api_key.get_secret_value()
        if s.openrouter_model:env['OPENROUTER_MODEL']=s.openrouter_model
        proc=await asyncio.create_subprocess_exec(s.node_bin,'--import','tsx',str(s.repo_root/'src/bridge/runner-cli.ts'),cwd=s.repo_root,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True,limit=MAX_LINE+1)
        async def send(value):
            proc.stdin.write((json.dumps({'protocol_version':1,'run_id':command['run_id'],**value},separators=(',',':'))+'\n').encode());await proc.stdin.drain()
        async def stderr():
            # Drain only; never persist provider diagnostics or credentials.
            while await proc.stderr.read(8192):pass
        async def cancellation():
            await cancel.wait()
            try:await send({'type':'cancel','reason':'user_cancelled'})
            except (BrokenPipeError,ConnectionResetError):pass
            await asyncio.sleep(15)
            if proc.returncode is None:os.killpg(proc.pid,signal.SIGTERM)
        drain=asyncio.create_task(stderr());control=asyncio.create_task(cancellation());completion=None
        try:
            await send(command)
            ready=await asyncio.wait_for(proc.stdout.readline(),10)
            if len(ready)>MAX_LINE:raise ValueError('Metadata too large')
            if validate_message(json.loads(ready),command['run_id'],1)['type']!='ready':raise ValueError('Ready expected')
            sequence=1
            while True:
                line=await proc.stdout.readline()
                if not line:raise RuntimeError('RUNNER_EXITED')
                if len(line)>MAX_LINE or not line.endswith(b'\n'):raise ValueError('Invalid metadata line')
                message=validate_message(json.loads(line),command['run_id'],sequence)
                if message['type']=='ready':raise ValueError('Duplicate ready')
                ack=await sink(message)
                await send({'type':'ack','message_seq':sequence,'event_sequence':ack['event_sequence'],'continue':ack['continue']})
                sequence+=1
                if not ack['continue']:raise RuntimeError('STORAGE_UPLOAD_FAILED')
                if message['type']=='completed':completion=message;break
            proc.stdin.close()
            await asyncio.wait_for(proc.wait(),5)
            if proc.returncode!=0:raise RuntimeError('RUNNER_EXITED')
            return completion
        finally:
            control.cancel()
            if proc.returncode is None:
                try:os.killpg(proc.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:await asyncio.wait_for(proc.wait(),2)
                except asyncio.TimeoutError:
                    try:os.killpg(proc.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    await proc.wait()
            await asyncio.gather(control,drain,return_exceptions=True)
