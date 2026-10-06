import asyncio
import copy
import json
from pathlib import Path

import pytest
from conftest import deployment, run

from interface_api.config import Settings
from interface_api.errors import ApiError
from interface_api.lifecycle import Lifecycle, outcome
from interface_api.worker import Worker

DEFINITION = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "tests/fixtures/replay-member-desk/artifact.json"
    ).read_text()
)


def proposal(selection=None):
    return {
        "proposal_version": 1,
        "capability_selection": selection
        or {
            "mode": "new",
            "name": "Member status",
            "description": "Search synthetic member",
            "reason": "New operation",
            "input_schema": DEFINITION["input_schema"],
            "output_schema": DEFINITION["output_schema"],
        },
        "parameter_values": {"email": "demo@example.test"},
        "observed_outputs": {"status": "Active"},
        "definition": copy.deepcopy(DEFINITION),
        "reference_assets": [],
    }


def bundle(repo, tmp_path, dep=None, selection=None):
    source = run(repo, dep)
    repo.transition(source["run_id"], "running")
    repo.transition(
        source["run_id"],
        "awaiting_finalization",
        runtime={"status": "awaiting_artifact_design"},
    )
    worker = Worker(repo, Settings(repo_root=tmp_path, _env_file=None), None, None)
    lifecycle = Lifecycle(repo, worker, None)
    worker.lifecycle = lifecycle
    artifact = asyncio.run(
        lifecycle.prepare_draft(source["run_id"], proposal(selection))
    )
    validation = lifecycle.start_validation(artifact["artifact_id"], {}, automatic=True)
    repo.transition(validation["run_id"], "running")
    repo.transition(
        validation["run_id"],
        "completed",
        {
            "outcome": outcome(
                "success", "GOAL_ACHIEVED", "Checked", {"status": "Active"}
            ),
            "validated_definition_sha256": artifact["definition_sha256"],
        },
    )
    return lifecycle, source, artifact, validation


def test_first_publication_atomic_and_reused_version_does_not_move_binding(
    repo, tmp_path
):
    dep = deployment(repo)
    life, source, artifact, validation = bundle(repo, tmp_path, dep)
    publication = life.publish_validated(
        source["run_id"], artifact["artifact_id"], validation["run_id"]
    )
    assert publication["binding_action"] == "initial_ready"
    published = repo.get("artifacts", "artifact_id", artifact["artifact_id"])
    assert published["version"] == 1
    binding = repo.rows("capability_bindings")[0]
    assert (
        life.publish_validated(
            source["run_id"], artifact["artifact_id"], validation["run_id"]
        )
        == publication
    )
    selected = {
        "mode": "reuse",
        "capability_id": published["capability_id"],
        "reason": "Same operation",
    }
    life, other, second, v2 = bundle(repo, tmp_path, dep, selected)
    result = life.publish_validated(
        other["run_id"], second["artifact_id"], v2["run_id"]
    )
    assert (
        result["binding_action"] == "unchanged"
        and repo.rows("capability_bindings")[0]["binding_id"] == binding["binding_id"]
    )
    assert repo.get("artifacts", "artifact_id", second["artifact_id"])["version"] == 2
    with pytest.raises(ApiError):
        life.activate(
            dep["app_deployment_id"],
            published["capability_id"],
            second["artifact_id"],
            v2["run_id"],
            0,
            None,
        )
    active = life.activate(
        dep["app_deployment_id"],
        published["capability_id"],
        second["artifact_id"],
        v2["run_id"],
        1,
        None,
    )
    assert active["binding_version"] == 2 and len(repo.rows("capability_bindings")) == 2
    with repo.db.transaction() as c:
        with pytest.raises(Exception):
            c.execute(
                "UPDATE artifacts SET definition_json=? WHERE artifact_id=?",
                ("{}", artifact["artifact_id"]),
            )
        with pytest.raises(Exception):
            c.execute(
                "UPDATE capabilities SET name=? WHERE capability_id=?",
                ("change", published["capability_id"]),
            )


def test_config_and_cancel_reject_publication_without_partial_capability(
    repo, tmp_path
):
    life, source, artifact, validation = bundle(repo, tmp_path)
    dep = repo.get("app_deployments", "app_deployment_id", source["app_deployment_id"])
    repo.update_deployment(
        dep["app_deployment_id"], 1, {"base_url": "http://127.0.0.1:4174"}
    )
    with pytest.raises(ApiError):
        life.publish_validated(
            source["run_id"], artifact["artifact_id"], validation["run_id"]
        )
    assert not repo.rows("capabilities") and not repo.rows("capability_bindings")
    life, source, artifact, validation = bundle(repo, tmp_path)
    repo.transition(source["run_id"], "cancelling")
    with pytest.raises(ApiError):
        life.publish_validated(
            source["run_id"], artifact["artifact_id"], validation["run_id"]
        )
    assert not repo.rows("capabilities")


def test_rollback_after_capability_insert_and_reuse_schema_drift(
    repo, tmp_path, monkeypatch
):
    life, source, artifact, validation = bundle(repo, tmp_path)
    original = life.new_binding
    monkeypatch.setattr(
        life,
        "new_binding",
        lambda *args: (_ for _ in ()).throw(RuntimeError("injected failure")),
    )
    with pytest.raises(RuntimeError):
        life.publish_validated(
            source["run_id"], artifact["artifact_id"], validation["run_id"]
        )
    assert (
        not repo.rows("capabilities")
        and repo.get("artifacts", "artifact_id", artifact["artifact_id"])["state"]
        == "validating"
    )
    monkeypatch.setattr(life, "new_binding", original)
    life.publish_validated(
        source["run_id"], artifact["artifact_id"], validation["run_id"]
    )
    cap = repo.rows("capabilities")[0]
    bad = proposal(
        {"mode": "reuse", "capability_id": cap["capability_id"], "reason": "same"}
    )
    bad["definition"]["output_schema"]["properties"]["status"]["enum"] = ["Other"]
    new = run(repo)
    repo.transition(new["run_id"], "running")
    repo.transition(new["run_id"], "awaiting_finalization")
    with pytest.raises(ValueError, match="SCHEMA_DRIFT"):
        asyncio.run(life.prepare_draft(new["run_id"], bad))


def test_validation_cancel_failure_remains_a_readable_source_outcome(repo, tmp_path):
    from interface_api.dto import RunDTO
    from interface_api.reads import Reads

    life, source, artifact, validation = bundle(repo, tmp_path)
    life.validation_failed(
        artifact,
        validation["run_id"],
        {"stop_reason": {"code": "USER_CANCELLED", "dispatch_state": "not_dispatched"}},
    )
    stopped = repo.get("runs", "run_id", source["run_id"])
    RunDTO.model_validate(Reads(repo).run(stopped))
