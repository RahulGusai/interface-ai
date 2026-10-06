import pytest
import asyncio
from pathlib import Path
from interface_api.worker import Worker
from interface_api.config import Settings
from conftest import run

class NeverRunner:
    async def run(self,*args):raise RuntimeError('RUNNER_EXITED')

@pytest.mark.asyncio
async def test_restart_and_crash_are_terminal(repo,tmp_path):
    worker=Worker(repo,Settings(repo_root=tmp_path,_env_file=None),None,NeverRunner())
    lost=run(repo);assert worker.startup_reconcile()==1
    assert repo.get('runs','run_id',lost['run_id'])['status']=='interrupted'
    assert repo.rows('run_events',order='sequence')[-1]['payload']['stop_reason']['code']=='PROCESS_RESTARTED'
    new=run(repo);await worker.execute_raw(new['run_id'])
    assert repo.get('runs','run_id',new['run_id'])['status']=='failed'
    assert repo.get('runs','run_id',new['run_id'])['result']['outcome']['code']=='RUNNER_EXITED'

@pytest.mark.asyncio
async def test_serial_worker_and_queued_cancellation(repo,tmp_path):
    worker=Worker(repo,Settings(repo_root=tmp_path,_env_file=None),None,NeverRunner());await worker.start()
    active=0;maximum=0;finished=[]
    class Lifecycle:
        async def execute(self,ident):
            nonlocal active,maximum
            active+=1;maximum=max(maximum,active);await asyncio.sleep(.01);active-=1;finished.append(ident)
    worker.lifecycle=Lifecycle();a,b,tombstone=run(repo),run(repo),run(repo)
    for row in (a,b,tombstone):worker.queue.put_nowait(row['run_id'])
    await worker.cancel(tombstone['run_id']);await worker.queue.join()
    assert maximum==1 and finished==[a['run_id'],b['run_id']]
    assert repo.get('runs','run_id',tombstone['run_id'])['status']=='cancelled'
    await worker.shutdown()
