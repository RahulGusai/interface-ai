"""Real Python/Node ACK bridge + Chromium, with a test SDK (not live MinIO)."""

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from conftest import deployment
from test_publication import bundle
from test_storage import SDK, Storage

from interface_api.bridge import NodeRunner
from interface_api.config import REPO_ROOT, Settings
from interface_api.evidence import Evidence


@pytest.mark.asyncio
async def test_node_replay_persists_real_png_before_ack(repo, tmp_path):
    html = (REPO_ROOT / "tests/fixtures/replay-member-desk/index.html").read_bytes()

    class Fixture(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    staging = tmp_path / "staging"
    staging.mkdir()
    settings = Settings(repo_root=REPO_ROOT, headless=True, _env_file=None)
    try:
        dep = deployment(repo)
        repo.update_deployment(
            dep["app_deployment_id"],
            1,
            {"base_url": f"http://127.0.0.1:{server.server_port}"},
        )
        dep = repo.get("app_deployments", "app_deployment_id", dep["app_deployment_id"])
        life, source, draft, validation = await asyncio.to_thread(
            bundle, repo, tmp_path, dep
        )
        life.publish_validated(
            source["run_id"], draft["artifact_id"], validation["run_id"]
        )
        artifact = repo.get("artifacts", "artifact_id", draft["artifact_id"])
        with repo.db.transaction() as c:
            run = repo.new_run(
                c,
                dep,
                "replay",
                artifact=artifact,
                inputs={"email": "other@example.test"},
                selection="explicit_artifact",
            )
        repo.transition(run["run_id"], "running")
        sdk = SDK()
        evidence = Evidence(repo, Storage("private", sdk, sdk))
        runner = NodeRunner(settings)
        assert await runner.probe(), (
            "Install supported Node/Chromium before running integration checks"
        )
        command = {
            "protocol_version": 1,
            "type": "start",
            "run_id": run["run_id"],
            "mode": "replay",
            "deployment": run["deployment_snapshot"],
            "task": None,
            "inputs": run["inputs"],
            "capability_catalog": [],
            "artifact": artifact,
            "assets": [],
            "staging_directory": str(staging),
            "runtime": {
                "headless": True,
                "max_tool_calls": 40,
                "allow_writes": True,
                "allow_screenshots": True,
                "path_prefix": "/",
            },
        }

        async def sink(message):
            if message["type"] == "event":
                return await evidence.persist(
                    run["run_id"], message["event"], message["assets"], staging
                )
            row = repo.event(
                run["run_id"],
                "runner_completed",
                {"runtime_result": message["runtime_result"]},
            )
            return {"event_sequence": row["sequence"], "continue": True}

        completion = await runner.run(command, sink, asyncio.Event())
        assert completion["runtime_result"]["status"] == "success", completion
        assert completion["runtime_result"]["outputs"] == {"status": "Pending"}
        assets = repo.rows("evidence_assets", order="event_sequence")
        assert assets and all(a["width"] == 1280 and a["height"] == 800 for a in assets)
        events = repo.rows("run_events", "run_id=?", (run["run_id"],), "sequence ASC")
        assert [e["sequence"] for e in events] == list(range(1, len(events) + 1))
        assert not list(staging.glob("*.png")) and not any(
            "model_proposed" == e["type"] for e in events
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
