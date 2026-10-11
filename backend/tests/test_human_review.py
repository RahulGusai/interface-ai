import pytest
from conftest import run

from interface_api.errors import ApiError


def evidence(repo, row, body):
    from interface_api.repositories import identifier, now

    asset_id = identifier()
    event = repo.event(
        row["run_id"],
        "human_review_snapshot",
        {
            k: body.get(k)
            for k in ("call_id", "tool", "arguments", "assessment", "state_fingerprint")
        },
        assets=[
            {
                "asset_id": asset_id,
                "kind": "observation_screenshot",
                "object_key": asset_id,
                "mime_type": "image/png",
                "sha256": "a" * 64,
                "byte_size": 10,
                "width": 1280,
                "height": 800,
                "captured_at": now(),
                "label": "Review",
                "result": None,
                "detail": None,
            }
        ],
    )
    return event["sequence"]


def test_review_pause_decision_and_duplicate_delivery(repo):
    from interface_api.reviews import Reviews

    row = run(repo, access_policy="READ_WRITE")
    repo.transition(row["run_id"], "running")
    service = Reviews(repo, timeout_seconds=300)
    body = {
        "review_id": "00000000-0000-4000-8000-000000000001",
        "call_id": "call-1",
        "tool": "click",
        "arguments": {"target": {"kind": "point", "x": 5, "y": 8}},
        "assessment": {
            "decision": "auto_approve",
            "confidence": 0.2,
            "reason": "uncertain",
        },
        "state_fingerprint": "a" * 64,
    }
    body["event_sequence"] = evidence(repo, row, body)
    review = service.create(row["run_id"], body)
    assert review["status"] == "pending"
    assert review["screenshot_asset_id"]
    assert repo.get("runs", "run_id", row["run_id"])["status"] == "awaiting_human"
    assert service.create(row["run_id"], body)["review_id"] == review["review_id"]
    decided = service.decide(review["review_id"], "approved", "Proceed")
    assert decided["status"] == "approved"
    assert (
        service.decide(review["review_id"], "approved", "Proceed")["decided_at"]
        == decided["decided_at"]
    )
    with pytest.raises(ApiError):
        service.decide(review["review_id"], "rejected", None)
    assert repo.get("runs", "run_id", row["run_id"])["status"] == "running"


def test_read_only_cannot_enter_review(repo):
    from interface_api.reviews import Reviews

    row = run(repo)
    repo.transition(row["run_id"], "running")
    with pytest.raises(ApiError) as exc:
        Reviews(repo).create(row["run_id"], {})
    assert exc.value.code == "REVIEW_NOT_ALLOWED"


def test_expiry_and_cancellation_prevent_late_approval(repo):
    from interface_api.reviews import Reviews

    row = run(repo, access_policy="READ_WRITE")
    repo.transition(row["run_id"], "running")
    service = Reviews(repo)
    body = {
        "review_id": "00000000-0000-4000-8000-000000000002",
        "call_id": "call-1",
        "tool": "click",
        "arguments": {},
        "assessment": None,
        "state_fingerprint": "b" * 64,
    }
    body["event_sequence"] = evidence(repo, row, body)
    review = service.create(row["run_id"], body)
    repo.transition(row["run_id"], "cancelling")
    assert service.get(review["review_id"])["status"] == "cancelled"
    with pytest.raises(ApiError):
        service.decide(review["review_id"], "approved", None)


@pytest.mark.parametrize("ending", ["expiry", "restart"])
def test_closed_reviews_never_resume(repo, tmp_path, ending):
    from interface_api.config import Settings
    from interface_api.reviews import Reviews
    from interface_api.worker import Worker

    row = run(repo, access_policy="READ_WRITE")
    repo.transition(row["run_id"], "running")
    service = Reviews(repo)
    body = {
        "review_id": "00000000-0000-4000-8000-000000000003",
        "call_id": "call-1",
        "tool": "click",
        "arguments": {},
        "assessment": None,
        "state_fingerprint": "c" * 64,
    }
    body["event_sequence"] = evidence(repo, row, body)
    service.create(row["run_id"], body)
    if ending == "expiry":
        with repo.db.transaction() as c:
            c.execute("UPDATE human_review SET expires_at='2000-01-01T00:00:00Z'")
        expected = "expired"
    else:
        Worker(
            repo, Settings(repo_root=tmp_path, _env_file=None), None, None
        ).startup_reconcile()
        assert repo.get("runs", "run_id", row["run_id"])["status"] == "interrupted"
        expected = "cancelled"
    assert service.get(body["review_id"])["status"] == expected
    with pytest.raises(ApiError):
        service.decide(body["review_id"], "approved")


def test_review_evidence_must_match_exact_action(repo):
    from interface_api.reviews import Reviews

    row = run(repo, access_policy="READ_WRITE")
    repo.transition(row["run_id"], "running")
    body = {
        "review_id": "00000000-0000-4000-8000-000000000004",
        "call_id": "call-1",
        "tool": "click",
        "arguments": {},
        "assessment": None,
        "state_fingerprint": "d" * 64,
    }
    body["event_sequence"] = evidence(repo, row, body)
    body["arguments"] = {"different": "action"}
    with pytest.raises(ApiError) as exc:
        Reviews(repo).create(row["run_id"], body)
    assert exc.value.code == "REVIEW_EVIDENCE_MISMATCH"
    assert repo.get("runs", "run_id", row["run_id"])["status"] == "running"
