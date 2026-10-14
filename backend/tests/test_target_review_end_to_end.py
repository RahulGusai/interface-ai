"""Choose a replay target through real HTTP, Node polling and Chromium."""

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
@pytest.mark.parametrize("policy", ["READ_WRITE", "READ_ONLY"])
async def test_selected_duplicate_executes_once_through_persisted_review(
    tmp_path, monkeypatch, policy
):
    writes = []
    html = (REPO_ROOT / "tests/fixtures/replay-member-desk/index.html").read_text()
    html = html.replace(
        '<main id="results">',
        '<button id="second">Search</button><main id="results">',
    ).replace(
        "</script>",
        """const render = search.onclick;
        search.onclick = async () => { await fetch('/first', {method:'POST'}); render(); };
        second.onclick = async () => { await fetch('/second', {method:'POST'}); render(); };
        </script>""",
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
                "confidence": 0.9,
                "reason": "Synthetic fixture action",
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
                "access_policy": policy,
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
                        params={
                            "run_id": run_id,
                            "status": "pending",
                        },
                    )
                    assert listed.status_code == 200, listed.text
                    if listed.json()["items"]:
                        review = listed.json()["items"][0]
                        break
                    current = (await client.get(f"/v1/runs/{run_id}")).json()
                    assert current["status"] not in ("failed", "completed"), current
                    await asyncio.sleep(0.05)
            assert not writes
            assert review["run_status"] == "awaiting_human"
            assert review["access_policy"] == policy
            assert review["target_resolution"]["reason"] == "ambiguous"
            candidates = review["target_resolution"]["candidates"]
            assert len(candidates) == 2
            assert all(c["bounds"]["width"] > 0 for c in candidates)
            image = repo.get(
                "evidence_assets", "asset_id", review["screenshot_asset_id"]
            )
            assert sdk.objects[image["object_key"]][0].startswith(b"\x89PNG")
            second = max(candidates, key=lambda c: c["bounds"]["x"])
            choice = {"decision": "approved", "selected_candidate_id": second["id"]}
            response = await client.post(
                f"/v1/human-reviews/{review['review_id']}/decision", json=choice
            )
            assert response.status_code == 200, response.text
            assert response.json()["selected_candidate_id"] == second["id"]
            # A duplicate delivery must acknowledge the same decision without another click.
            duplicate = await client.post(
                f"/v1/human-reviews/{review['review_id']}/decision", json=choice
            )
            assert duplicate.status_code == 200, duplicate.text
            async with asyncio.timeout(20):
                while True:
                    current = (await client.get(f"/v1/runs/{run_id}")).json()
                    if current["status"] in ("completed", "failed", "cancelled"):
                        break
                    await asyncio.sleep(0.05)
            assert current["status"] == "completed", current
            assert current["outcome"]["outputs"] == {"status": "Pending"}
            assert writes == ["/second"]
            events = repo.rows("run_events", "run_id=?", (run_id,), "sequence ASC")
            assert not any(e["type"] == "model_proposed" for e in events)
            decisions = [e for e in events if e["type"] == "human_review_decided"]
            assert len(decisions) == 1
            assert decisions[0]["payload"]["selected_candidate_id"] == second["id"]
            assert (
                len(
                    [
                        e
                        for e in events
                        if e["type"] == "tool_started" and e["step_id"] == "s002"
                    ]
                )
                == 1
            )
            assert (
                repo.get("artifacts", "artifact_id", draft["artifact_id"])[
                    "definition_sha256"
                ]
                == draft["definition_sha256"]
            )
    finally:
        server.should_exit = True
        await serving
        target.shutdown()
        target.server_close()
        target_thread.join()
