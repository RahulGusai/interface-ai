"""Real HTTP API, sequential worker, Node polling and Chromium; synthetic storage."""

import asyncio
import copy
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import httpx
import pytest
import test_publication
import uvicorn
from test_storage import SDK, Storage

from interface_api.bridge import NodeRunner
from interface_api.config import REPO_ROOT, Settings
from interface_api.main import create_app


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["approved", "rejected", "expired", "cancelled"])
async def test_pending_review_controls_same_run_and_execution_slot(
    tmp_path, monkeypatch, decision
):
    writes = []
    html = (
        (REPO_ROOT / "tests/fixtures/replay-member-desk/index.html")
        .read_text()
        .replace(
            "search.onclick = () => {",
            "search.onclick = async () => { await fetch('/write', {method:'POST'});",
        )
    )

    class Target(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html.encode())

        def do_POST(self):
            writes.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"saved")

        def log_message(self, *args):
            pass

    target = ThreadingHTTPServer(("127.0.0.1", 0), Target)
    target_thread = threading.Thread(target=target.serve_forever, daemon=True)
    target_thread.start()
    api_socket = socket.socket()
    api_socket.bind(("127.0.0.1", 0))
    api_url = f"http://127.0.0.1:{api_socket.getsockname()[1]}"
    settings = Settings(
        repo_root=tmp_path,
        INTERFACE_RUNTIME_API_URL=api_url,
        INTERFACE_BROWSER_HEADLESS=True,
        INTERFACE_REVIEW_TIMEOUT_SECONDS=30,
        _env_file=None,
    )
    sdk = SDK()
    app = create_app(
        settings, Storage("private", sdk, sdk), NodeRunner(Settings(_env_file=None))
    )
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="on"))
    serving = asyncio.create_task(server.serve(sockets=[api_socket]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                await asyncio.sleep(0.02)
        definition = copy.deepcopy(test_publication.DEFINITION)
        for step in definition["steps"]:
            step["execution"] = {
                "decision": "auto_approve",
                "confidence": 1,
                "reason": "Synthetic read",
            }
        definition["steps"][1]["execution"] = {
            "decision": "requires_human_review",
            "confidence": 1,
            "reason": "Submit synthetic write",
        }
        monkeypatch.setattr(test_publication, "DEFINITION", definition)
        repo = app.state.repo
        dep = repo.create_deployment(
            {
                "tenant_id": "demo",
                "product_id": "desk",
                "base_url": f"http://127.0.0.1:{target.server_port}",
                "environment": "test",
                "ui_variant": "standard",
            }
        )
        life, source, draft, validation = await asyncio.to_thread(
            test_publication.bundle, repo, tmp_path, dep
        )
        life.publish_validated(
            source["run_id"], draft["artifact_id"], validation["run_id"]
        )
        async with httpx.AsyncClient(base_url=api_url, timeout=10) as client:
            body = {
                "kind": "replay",
                "app_deployment_id": dep["app_deployment_id"],
                "artifact_id": draft["artifact_id"],
                "inputs": {"email": "other@example.test"},
                "access_policy": "READ_WRITE",
            }
            started = await client.post(
                "/v1/runs", json=body, headers={"Idempotency-Key": str(uuid4())}
            )
            assert started.status_code == 202, started.text
            run_id = started.json()["run_id"]
            async with asyncio.timeout(20):
                while True:
                    listed = await client.get(
                        "/v1/human-reviews",
                        params={"run_id": run_id, "status": "pending"},
                    )
                    assert listed.status_code == 200, listed.text
                    items = listed.json()["items"]
                    if items:
                        review = items[0]
                        break
                    current = (await client.get(f"/v1/runs/{run_id}")).json()
                    assert current["status"] not in ("failed", "completed"), current
                    await asyncio.sleep(0.05)
            assert review["tool"] == "click" and review["confidence"] == 1
            assert review["run_status"] == "awaiting_human" and not writes
            image = repo.get(
                "evidence_assets", "asset_id", review["screenshot_asset_id"]
            )
            assert sdk.objects[image["object_key"]][0].startswith(b"\x89PNG")
            queued = await client.post(
                "/v1/runs", json=body, headers={"Idempotency-Key": str(uuid4())}
            )
            queued_id = queued.json()["run_id"]
            await asyncio.sleep(0.1)
            assert (await client.get(f"/v1/runs/{queued_id}")).json()[
                "status"
            ] == "queued"
            assert (
                await client.post(f"/v1/runs/{queued_id}/cancel")
            ).status_code == 202
            review_id = review["review_id"]
            if decision == "expired":
                # Advance the durable deadline without a wall-clock wait.
                with repo.db.transaction() as c:
                    c.execute(
                        "UPDATE human_review SET expires_at='2000-01-01T00:00:00Z' WHERE review_id=?",
                        (review_id,),
                    )
            elif decision == "cancelled":
                assert (
                    await client.post(f"/v1/runs/{run_id}/cancel")
                ).status_code == 202
            else:
                response = await client.post(
                    f"/v1/human-reviews/{review_id}/decision",
                    json={"decision": decision, "comment": "Test operator"},
                )
                assert response.status_code == 200, response.text
            async with asyncio.timeout(20):
                while True:
                    current = (await client.get(f"/v1/runs/{run_id}")).json()
                    if current["status"] in ("completed", "failed", "cancelled"):
                        break
                    await asyncio.sleep(0.05)
            assert (await client.get(f"/v1/human-reviews/{review_id}")).json()[
                "status"
            ] == decision
            if decision == "approved":
                assert current["status"] == "completed", current
                assert current["outcome"]["outputs"] == {"status": "Pending"}
                assert writes == ["/write"]
            else:
                assert current["status"] == (
                    "cancelled" if decision == "cancelled" else "failed"
                ), current
                assert not writes
                if decision != "cancelled":
                    assert (
                        current["outcome"]["code"] == "HUMAN_REVIEW_" + decision.upper()
                    )
                    assert current["outcome"]["dispatch_state"] == "not_dispatched"
                late = await client.post(
                    f"/v1/human-reviews/{review_id}/decision",
                    json={"decision": "approved"},
                )
                assert late.status_code == 409
            events = repo.rows("run_events", "run_id=?", (run_id,), "sequence ASC")
            assert not any(e["type"] == "model_proposed" for e in events)
            assert len([e for e in events if e["type"] == "run_started"]) == 1
    finally:
        server.should_exit = True
        await serving
        target.shutdown()
        target.server_close()
        target_thread.join()
