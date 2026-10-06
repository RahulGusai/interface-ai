import asyncio
import hashlib

from conftest import run
from test_storage import SDK, png

from interface_api.evidence import Evidence
from interface_api.storage import Storage


def test_ack_after_event_and_asset_commit(repo, tmp_path):
    r = run(repo)
    path = tmp_path / "shot.png"
    path.write_bytes(png())
    sdk = SDK()
    sink = Evidence(repo, Storage("private", sdk, sdk))
    ack = asyncio.run(
        sink.persist(
            r["run_id"],
            {
                "type": "tool_finished",
                "payload": {
                    "result": {"status": "completed"},
                    "dispatch_state": "completed",
                },
            },
            [
                {
                    "staged_path": "shot.png",
                    "kind": "post_tool_screenshot",
                    "sha256": hashlib.sha256(png()).hexdigest(),
                    "width": 2,
                    "height": 2,
                    "captured_at": r["created_at"],
                }
            ],
            tmp_path,
        )
    )
    assert ack == {"continue": True, "event_sequence": 1} and not path.exists()
    asset = repo.rows("evidence_assets", order="captured_at")[0]
    assert (
        asset["event_sequence"] == 1
        and repo.rows("run_events", order="sequence")[0]["payload"]["evidence"][
            "status"
        ]
        == "available"
    )


def test_upload_failure_commits_honest_event_and_denies_next_action(repo, tmp_path):
    class Broken(SDK):
        def put_object(self, *a, **kw):
            raise RuntimeError("secret SDK failure")

    r = run(repo)
    (tmp_path / "shot.png").write_bytes(png())
    sink = Evidence(repo, Storage("private", Broken(), SDK()))
    ack = asyncio.run(
        sink.persist(
            r["run_id"],
            {"type": "tool_finished", "payload": {"dispatch_state": "completed"}},
            [
                {
                    "staged_path": "shot.png",
                    "kind": "post_tool_screenshot",
                    "sha256": hashlib.sha256(png()).hexdigest(),
                    "width": 2,
                    "height": 2,
                    "captured_at": r["created_at"],
                }
            ],
            tmp_path,
        )
    )
    assert not ack["continue"] and not repo.rows("evidence_assets", order="captured_at")
    payload = repo.rows("run_events", order="sequence")[0]["payload"]
    assert payload["evidence"]["status"] == "upload_failed" and "secret" not in str(
        payload
    )
