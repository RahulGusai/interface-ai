import asyncio

import pytest
from conftest import run

from interface_api.config import Settings
from interface_api.worker import Worker


class NeverRunner:
    async def run(self, *args):
        raise RuntimeError("RUNNER_EXITED")


@pytest.mark.asyncio
async def test_worker_command_has_no_policy_configuration(repo, tmp_path):
    commands = []

    class CaptureRunner:
        async def run(self, command, *args):
            commands.append(command)
            raise RuntimeError("RUNNER_EXITED")

    settings = Settings(repo_root=tmp_path, _env_file=None)
    worker = Worker(repo, settings, None, CaptureRunner())
    pending = run(repo)
    await worker.execute_raw(pending["run_id"])
    assert commands[0]["runtime"] == {"headless": False, "max_tool_calls": 40}
    assert (
        commands[0]["deployment"]["base_url"]
        == pending["deployment_snapshot"]["base_url"]
    )


@pytest.mark.asyncio
async def test_restart_and_crash_are_terminal(repo, tmp_path):
    worker = Worker(
        repo, Settings(repo_root=tmp_path, _env_file=None), None, NeverRunner()
    )
    lost = run(repo)
    assert worker.startup_reconcile() == 1
    assert repo.get("runs", "run_id", lost["run_id"])["status"] == "interrupted"
    assert (
        repo.rows("run_events", order="sequence")[-1]["payload"]["stop_reason"]["code"]
        == "PROCESS_RESTARTED"
    )
    new = run(repo)
    await worker.execute_raw(new["run_id"])
    assert repo.get("runs", "run_id", new["run_id"])["status"] == "failed"
    assert (
        repo.get("runs", "run_id", new["run_id"])["result"]["outcome"]["code"]
        == "RUNNER_EXITED"
    )


@pytest.mark.asyncio
async def test_serial_worker_and_queued_cancellation(repo, tmp_path):
    worker = Worker(
        repo, Settings(repo_root=tmp_path, _env_file=None), None, NeverRunner()
    )
    await worker.start()
    active = 0
    maximum = 0
    finished = []

    class Lifecycle:
        async def execute(self, ident):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            await asyncio.sleep(0.01)
            active -= 1
            finished.append(ident)

    worker.lifecycle = Lifecycle()
    a, b, tombstone = run(repo), run(repo), run(repo)
    for row in (a, b, tombstone):
        worker.queue.put_nowait(row["run_id"])
    await worker.cancel(tombstone["run_id"])
    await worker.queue.join()
    assert maximum == 1 and finished == [a["run_id"], b["run_id"]]
    assert repo.get("runs", "run_id", tombstone["run_id"])["status"] == "cancelled"
    await worker.shutdown()


@pytest.mark.asyncio
async def test_shutdown_interrupts_pending_jobs_without_dispatch(repo, tmp_path):
    worker = Worker(
        repo, Settings(repo_root=tmp_path, _env_file=None), None, NeverRunner()
    )
    await worker.start()
    dispatched = []

    class MustNotRun:
        async def execute(self, ident):
            dispatched.append(ident)

    worker.lifecycle = MustNotRun()
    pending = run(repo)
    worker.queue.put_nowait(pending["run_id"])
    await worker.shutdown()
    assert not dispatched
    stopped = repo.get("runs", "run_id", pending["run_id"])
    assert (
        stopped["status"] == "interrupted"
        and stopped["result"]["stop_reason"]["code"] == "SERVICE_SHUTDOWN"
    )


@pytest.mark.asyncio
async def test_manual_validation_source_cancel_signals_running_child(repo, tmp_path):
    from test_publication import bundle

    life, source, artifact, validation = await asyncio.to_thread(bundle, repo, tmp_path)
    worker = life.worker
    worker.active = validation["run_id"]
    worker.cancel_signal = asyncio.Event()
    # A retry validation is admitted after a failed prior attempt.
    repo.transition(
        source["run_id"],
        "failed",
        {
            "outcome": {
                "kind": "hard_failure",
                "code": "TEST",
                "message": "Previous failure",
            }
        },
    )
    with repo.db.transaction() as c:
        c.execute(
            "UPDATE artifacts SET state='validation_failed' WHERE artifact_id=?",
            (artifact["artifact_id"],),
        )
    retry = life.start_validation(
        artifact["artifact_id"], {"email": "demo@example.test"}
    )
    repo.transition(retry["run_id"], "running")
    worker.active = retry["run_id"]
    await worker.cancel(source["run_id"])
    assert worker.cancel_signal.is_set()
    assert repo.get("runs", "run_id", retry["run_id"])["status"] == "cancelling"


@pytest.mark.asyncio
async def test_queued_validation_cancel_settles_source_and_draft(repo, tmp_path):
    from test_publication import bundle

    from interface_api.dto import RunDTO
    from interface_api.reads import Reads

    life, source, artifact, validation = await asyncio.to_thread(bundle, repo, tmp_path)
    repo.transition(
        source["run_id"],
        "failed",
        {
            "outcome": {
                "kind": "hard_failure",
                "code": "TEST",
                "message": "Previous failure",
            }
        },
    )
    with repo.db.transaction() as c:
        c.execute(
            "UPDATE artifacts SET state='validation_failed' WHERE artifact_id=?",
            (artifact["artifact_id"],),
        )
    retry = life.start_validation(
        artifact["artifact_id"], {"email": "demo@example.test"}
    )
    await life.worker.cancel(retry["run_id"])
    stopped = repo.get("runs", "run_id", source["run_id"])
    assert stopped["status"] in ("failed", "cancelled")
    assert (
        repo.get("artifacts", "artifact_id", artifact["artifact_id"])["state"]
        == "validation_failed"
    )
    RunDTO.model_validate(Reads(repo).run(stopped))


@pytest.mark.asyncio
async def test_source_cancel_of_queued_retry_finishes_bundle_immediately(
    repo, tmp_path
):
    from test_publication import bundle

    life, source, artifact, validation = await asyncio.to_thread(bundle, repo, tmp_path)
    repo.transition(
        source["run_id"],
        "failed",
        {
            "outcome": {
                "kind": "hard_failure",
                "code": "TEST",
                "message": "Previous failure",
            }
        },
    )
    with repo.db.transaction() as c:
        c.execute(
            "UPDATE artifacts SET state='validation_failed' WHERE artifact_id=?",
            (artifact["artifact_id"],),
        )
    retry = life.start_validation(
        artifact["artifact_id"], {"email": "demo@example.test"}
    )
    await life.worker.cancel(source["run_id"])
    assert repo.get("runs", "run_id", source["run_id"])["status"] == "cancelled"
    assert repo.get("runs", "run_id", retry["run_id"])["status"] == "cancelled"
    assert (
        repo.get("artifacts", "artifact_id", artifact["artifact_id"])["state"]
        == "validation_failed"
    )
