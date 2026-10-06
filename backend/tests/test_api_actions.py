import asyncio
import json
from uuid import uuid4

import pytest
from conftest import deployment, run
from fastapi.testclient import TestClient
from test_publication import bundle
from test_storage import SDK, Storage

from interface_api.config import Settings
from interface_api.errors import ApiError
from interface_api.main import create_app
from interface_api.reads import Reads
from interface_api.services import Services
from interface_api.worker import Worker


class FailedRunner:
    async def run(self, command, sink, cancel):
        result = {
            "status": "agent_stopped_unverified",
            "summary": "Scripted test terminal text",
        }
        message = {
            "protocol_version": 1,
            "type": "completed",
            "run_id": command["run_id"],
            "message_seq": 1,
            "runtime_result": result,
            "discovery_proposal": None,
        }
        await sink(message)
        return message


def settings(tmp_path):
    return Settings(
        repo_root=tmp_path,
        openrouter_api_key="test-only",
        openrouter_model="test-only",
        _env_file=None,
    )


def test_starts_idempotency_http_contract_and_real_reads(tmp_path):
    sdk = SDK()
    app = create_app(settings(tmp_path), Storage("private", sdk, sdk), FailedRunner())
    with TestClient(app) as client:
        dep = client.post(
            "/v1/app-deployments",
            json={
                "tenant_id": "demo",
                "product_id": "desk",
                "base_url": "http://localhost:4173",
                "environment": "test",
                "ui_variant": "standard",
            },
        ).json()
        key = str(uuid4())
        body = {
            "kind": "discovery",
            "app_deployment_id": dep["app_deployment_id"],
            "task": "An unknown natural language operation",
        }
        accepted = client.post("/v1/runs", json=body, headers={"Idempotency-Key": key})
        assert accepted.status_code == 202, accepted.text
        ident = accepted.json()["run_id"]
        assert (
            client.post("/v1/runs", json=body, headers={"Idempotency-Key": key}).json()[
                "run_id"
            ]
            == ident
        )
        assert (
            client.post(
                "/v1/runs",
                json={**body, "task": "different"},
                headers={"Idempotency-Key": key},
            ).status_code
            == 409
        )
        assert client.get("/v1/runs/by-request/" + key).json()["run_id"] == ident
        assert client.post("/v1/runs", json=body).status_code == 422
        assert (
            client.post(
                "/v1/runs",
                json={**body, "task": " "},
                headers={"Idempotency-Key": str(uuid4())},
            ).status_code
            == 422
        )
        assert client.get("/v1/runs?order_by=bogus").status_code == 422
        assert client.get("/v1/runs?direction=sideways").status_code == 422
        assert (
            client.get("/v1/runs/" + ident + "/events?after_sequence=-1").status_code
            == 400
        )
        assert (
            client.get("/v1/runs?purpose=user&page=20&page_size=5").json()["page"] == 1
        )
        assert client.get("/v1/artifacts/missing").status_code == 404
        assert client.get("/v1/evidence-assets/missing/content-url").status_code == 404
        assert client.get("/health/ready").json()["discovery_available"] is True
        openapi = client.get("/openapi.json").json()
        assert "/v1/artifacts/{ident}/validate" in openapi["paths"]
        assert not any(
            word in json.dumps(openapi)
            for word in ("waiting_handoff", "app_instance_id", "/pause", "/resume")
        )
        assert client.get("/v1/runs/" + ident).json()["task"] == body["task"]


@pytest.mark.asyncio
async def test_queue_full_has_no_row_and_exact_pin_keeps_binding_snapshot(
    repo, tmp_path
):
    dep = deployment(repo)
    life, source, artifact, validation = await asyncio.to_thread(
        bundle, repo, tmp_path, dep
    )
    life.publish_validated(
        source["run_id"], artifact["artifact_id"], validation["run_id"]
    )
    published = repo.get("artifacts", "artifact_id", artifact["artifact_id"])
    worker = Worker(repo, settings(tmp_path), None, None)
    service = Services(repo, worker, life, None, True, True)
    body = {
        "kind": "replay",
        "app_deployment_id": dep["app_deployment_id"],
        "artifact_id": artifact["artifact_id"],
        "inputs": {"email": "other@example.test"},
    }
    row = await service.admit(str(uuid4()), body)
    assert (
        row["binding_version"] == 1
        and row["artifact_version"] == 1
        and row["artifact_definition_sha256"] == published["definition_sha256"]
    )
    before = len(repo.rows("runs"))
    with pytest.raises(ApiError) as exc:
        await service.admit(str(uuid4()), {**body, "inputs": {"email": 42}})
    assert exc.value.status == 422 and len(repo.rows("runs")) == before
    other = deployment(repo)
    with pytest.raises(ApiError) as exc:
        await service.admit(
            str(uuid4()),
            {
                "kind": "replay",
                "app_deployment_id": other["app_deployment_id"],
                "inputs": {"email": "demo@example.test"},
            },
            validation_artifact=artifact["artifact_id"],
        )
    assert exc.value.code == "CROSS_DEPLOYMENT_VALIDATION_DEFERRED"
    while not worker.queue.full():
        worker.queue.put_nowait("tombstone")
    with pytest.raises(ApiError) as exc:
        await service.admit(str(uuid4()), body)
    assert exc.value.code == "QUEUE_FULL" and len(repo.rows("runs")) == before
    # Changed config does not rewrite an admitted run's snapshot.
    repo.update_deployment(
        dep["app_deployment_id"], 1, {"base_url": "http://localhost:8888"}
    )
    assert (
        Reads(repo).run(repo.get("runs", "run_id", row["run_id"]))[
            "deployment_snapshot"
        ]["config_version"]
        == 1
    )
    assert (
        Reads(repo).eligibility(
            published,
            repo.get("app_deployments", "app_deployment_id", dep["app_deployment_id"]),
        )["state"]
        == "validation_needed"
    )


def test_filtered_events_cursor_never_repeats_or_skips_a_scan(repo):
    source = run(repo)
    for index in range(205):
        repo.event(source["run_id"], "odd" if index % 2 else "even", {"index": index})
    reader = Reads(repo)
    cursor = 0
    seen = []
    while True:
        result = reader.events(source["run_id"], cursor, 17, "odd")
        assert result["next_after_sequence"] > cursor
        cursor = result["next_after_sequence"]
        seen.extend(e["payload"]["index"] for e in result["items"])
        if not result["has_more"]:
            break
    assert seen == list(range(1, 205, 2)) and cursor == 205
