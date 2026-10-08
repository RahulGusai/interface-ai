import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from conftest import run

from interface_api.config import Settings
from interface_api.lifecycle import Lifecycle, outcome
from interface_api.worker import Worker

ROOT = Path(__file__).resolve().parents[2]
# Use the actual TS builder so Python storage checks cannot diverge from its output.
SCRIPT = """
import {buildArtifact} from './src/runtime/artifact-builder.ts';
const command=JSON.parse(process.argv[1]);
const outputs={...JSON.parse('{"__proto__":{"__proto__":"nested"}}'),balance:'reported',nested:{kind:'visual',asset_id:'ordinary data',x:2,url:'https://example.org'},'odd.key':[null],x:1};
const artifact=buildArtifact({deployment:command.deployment,capability_catalog:[],inputs:command.inputs,records:[{call_id:'bootstrap',tool:'navigate',input:{url:'https://other.example/path?q=..'},result:{status:'completed'}}],references:[]},command.task,outputs);
process.stdout.write(JSON.stringify({type:'completed',runtime_result:{status:'goal_achieved',summary:'Reported',outputs},discovery_artifact:artifact}));
"""


class BuiltArtifactRunner:
    def __init__(self):
        self.calls = 0

    async def run(self, command, persist, cancel):
        self.calls += 1
        completed = subprocess.run(
            [
                "node",
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                SCRIPT,
                json.dumps(command),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        message = json.loads(completed.stdout)
        await persist(message)
        return message


def lifecycle(repo, tmp_path):
    runner = BuiltArtifactRunner()
    worker = Worker(repo, Settings(repo_root=tmp_path, _env_file=None), None, runner)
    worker.cancel_signal = asyncio.Event()
    life = Lifecycle(repo, worker, None)
    worker.lifecycle = life
    return life, runner


def test_runtime_artifact_is_persisted_before_discovery_completes(repo, tmp_path):
    source = run(repo)
    life, runner = lifecycle(repo, tmp_path)
    asyncio.run(life.execute(source["run_id"]))
    completed = repo.get("runs", "run_id", source["run_id"])
    assert completed["status"] == "completed"
    assert runner.calls == 1  # No automatic replay or model retry.
    artifact = repo.get("artifacts", "artifact_id", completed["finalized_artifact_id"])
    assert artifact["state"] == "draft"
    assert artifact["source_run_id"] == source["run_id"]
    assert len(artifact["definition"]["steps"]) == 1
    assert completed["result"]["outcome"]["outputs"]["odd.key"] == [None]
    assert completed["result"]["outcome"]["outputs"]["__proto__"] == {
        "__proto__": "nested"
    }
    assert artifact["definition"]["output_mapping"]["__proto__"]["value"] == {
        "__proto__": "nested"
    }
    events = repo.rows("run_events", "run_id=?", (source["run_id"],), "sequence ASC")
    types = [e["type"] for e in events]
    assert types.index("artifact_draft_created") < types.index("run_completed")
    assert not repo.rows("runs", "purpose='validation'")
    assert (
        "discovery_artifact"
        in next(e for e in events if e["type"] == "runner_completed")["payload"]
    )
    # A restart must preserve stored drafts whose discovery already completed.
    life.worker.startup_reconcile()
    assert (
        repo.get("artifacts", "artifact_id", artifact["artifact_id"])["state"]
        == "draft"
    )
    # Explicit validation remains available after discovery has completed.
    validation = life.start_validation(artifact["artifact_id"], {})
    assert validation["purpose"] == "validation"
    assert repo.get("runs", "run_id", source["run_id"])["status"] == "validating"
    repo.transition(validation["run_id"], "running")
    repo.transition(
        validation["run_id"],
        "completed",
        {
            "outcome": outcome(
                "success",
                "GOAL_ACHIEVED",
                "Replay checked",
                completed["result"]["outcome"]["outputs"],
            ),
            "validated_definition_sha256": artifact["definition_sha256"],
        },
    )
    life.publish_validated(
        source["run_id"], artifact["artifact_id"], validation["run_id"]
    )
    assert (
        repo.get("artifacts", "artifact_id", artifact["artifact_id"])["state"]
        == "published"
    )


@pytest.mark.parametrize("failure", ["build_missing", "database"])
def test_artifact_failure_cannot_report_success(repo, tmp_path, monkeypatch, failure):
    source = run(repo)
    life, runner = lifecycle(repo, tmp_path)
    if failure == "database":
        original = repo.insert

        def insert(conn, table, data):
            if table == "artifacts":
                raise RuntimeError("Database unavailable")
            return original(conn, table, data)

        monkeypatch.setattr(repo, "insert", insert)
    else:

        async def missing(command, persist, cancel):
            return {
                "runtime_result": {
                    "status": "goal_achieved",
                    "summary": "Done",
                    "outputs": {},
                }
            }

        monkeypatch.setattr(runner, "run", missing)
    asyncio.run(life.execute(source["run_id"]))
    failed = repo.get("runs", "run_id", source["run_id"])
    assert failed["status"] == "failed"
    assert failed["result"]["outcome"]["kind"] == "hard_failure"
    assert failed["result"]["outcome"]["code"] == "ARTIFACT_FINALIZATION_FAILED"
    assert not failed["finalized_artifact_id"]
    assert not repo.rows("artifacts")


def test_runtime_build_failure_remains_a_finalization_failure(
    repo, tmp_path, monkeypatch
):
    source = run(repo)
    life, runner = lifecycle(repo, tmp_path)

    async def build_failed(command, persist, cancel):
        return {
            "runtime_result": {
                "status": "tool_error",
                "summary": "Artifact construction failed",
                "error": {"code": "ARTIFACT_BUILD_FAILED"},
            }
        }

    monkeypatch.setattr(runner, "run", build_failed)
    asyncio.run(life.execute(source["run_id"]))
    failed = repo.get("runs", "run_id", source["run_id"])
    assert failed["status"] == "failed"
    assert failed["result"]["outcome"]["code"] == "ARTIFACT_BUILD_FAILED"
    assert failed["result"]["outcome"]["failure_stage"] == "finalization"
    assert not repo.rows("artifacts")
