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
            for k in (
                "call_id",
                "tool",
                "arguments",
                "assessment",
                "state_fingerprint",
                "target_resolution",
            )
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


def target_review(repo, access_policy="READ_ONLY", candidates=None):
    from interface_api.repositories import identifier
    from interface_api.reviews import Reviews

    row = run(repo, access_policy=access_policy)
    repo.transition(row["run_id"], "running")
    body = {
        "review_id": identifier(),
        "call_id": "target-call",
        "tool": "click",
        "arguments": {"target": {"kind": "control", "text": "Open"}},
        "assessment": None,
        "state_fingerprint": "e" * 64,
        "target_resolution": {
            "reason": "ambiguous" if candidates is None else "not_found",
            "candidates": candidates
            if candidates is not None
            else [
                {
                    "id": "left",
                    "label": "Open left",
                    "bounds": {
                        "x": 0,
                        "y": 1,
                        "width": 50,
                        "height": 20,
                    },
                },
                {
                    "id": "right",
                    "label": "Open right",
                    "bounds": {
                        "x": 1230,
                        "y": 780,
                        "width": 50,
                        "height": 20,
                    },
                },
            ],
        },
    }
    body["event_sequence"] = evidence(repo, row, body)
    return row, body, Reviews(repo)


def test_target_choice_is_persisted_and_delivered_without_risk_approval(repo):
    row, body, service = target_review(repo)
    review = service.create(row["run_id"], body)
    assert review["access_policy"] == "READ_ONLY"
    assert review["target_resolution"] == body["target_resolution"]
    result = service.decide(review["review_id"], "approved", "Left", "left")
    assert result["selected_candidate_id"] == "left"
    assert result["refresh_targets"] is False
    assert result["run_status"] == "running"
    assert service.get(review["review_id"])["selected_candidate_id"] == "left"
    assert service.decide(review["review_id"], "approved", "Left", "left") == result
    with pytest.raises(ApiError) as exc:
        service.decide(review["review_id"], "approved", "Left", "right")
    assert exc.value.status == 409
    event = repo.rows(
        "run_events",
        "run_id=? AND type='human_review_decided'",
        (row["run_id"],),
        order="",
    )[0]["payload"]
    assert event["selected_candidate_id"] == "left"
    assert event["refresh_targets"] is False
    assert event["target_resolution"] == body["target_resolution"]


def test_refresh_empty_targets_resumes_for_a_new_review(repo):
    row, body, service = target_review(repo, candidates=[])
    review = service.create(row["run_id"], body)
    result = service.decide(review["review_id"], "approved", refresh_targets=True)
    assert result["refresh_targets"] is True
    assert result["selected_candidate_id"] is None
    assert result["run_status"] == "running"
    assert (
        service.decide(review["review_id"], "approved", refresh_targets=True) == result
    )
    from interface_api.repositories import identifier

    body["review_id"] = identifier()
    body["event_sequence"] = evidence(repo, row, body)
    assert service.create(row["run_id"], body)["status"] == "pending"


@pytest.mark.parametrize(
    "decision,selected,refresh",
    [
        ("approved", None, False),
        ("approved", "unknown", False),
        ("approved", "left", True),
        ("rejected", "left", False),
        ("rejected", None, True),
        ("approved", "", False),
        ("approved", "left", "true"),
    ],
)
def test_invalid_target_decisions_do_not_resume(repo, decision, selected, refresh):
    row, body, service = target_review(repo)
    review = service.create(row["run_id"], body)
    with pytest.raises(ApiError) as exc:
        service.decide(
            review["review_id"],
            decision,
            selected_candidate_id=selected,
            refresh_targets=refresh,
        )
    assert exc.value.status == 422
    assert service.get(review["review_id"])["status"] == "pending"
    assert repo.get("runs", "run_id", row["run_id"])["status"] == "awaiting_human"


@pytest.mark.parametrize("selected,refresh", [("left", False), (None, True)])
def test_ordinary_review_forbids_target_decisions(repo, selected, refresh):
    row, body, service = target_review(repo, access_policy="READ_WRITE")
    body.pop("target_resolution")
    body["event_sequence"] = evidence(repo, row, body)
    review = service.create(row["run_id"], body)
    with pytest.raises(ApiError) as exc:
        service.decide(
            review["review_id"],
            "approved",
            selected_candidate_id=selected,
            refresh_targets=refresh,
        )
    assert exc.value.status == 422


@pytest.mark.parametrize(
    "bounds",
    [
        {"x": -1, "y": 0, "width": 10, "height": 10},
        {"x": 0, "y": 0, "width": 0, "height": 10},
        {"x": 0, "y": 0, "width": 10, "height": -1},
        {"x": float("inf"), "y": 0, "width": 10, "height": 10},
        {"x": 1280, "y": 0, "width": 10, "height": 10},
        {"x": 0, "y": 791, "width": 10, "height": 10},
    ],
)
def test_target_review_validates_bounds_for_direct_service_calls(repo, bounds):
    row, body, service = target_review(repo, access_policy="READ_WRITE")
    body["target_resolution"]["candidates"][0]["bounds"] = bounds
    # Match the stored snapshot so bounds validation cannot be replaced by
    # merely checking that the request equals the event.
    if bounds["x"] != float("inf"):
        body["event_sequence"] = evidence(repo, row, body)
    with pytest.raises(ApiError) as exc:
        service.create(row["run_id"], body)
    assert exc.value.status == 422
    assert repo.get("runs", "run_id", row["run_id"])["status"] == "running"


def test_target_review_evidence_includes_candidate_context(repo):
    row, body, service = target_review(repo, access_policy="READ_WRITE")
    body["target_resolution"]["candidates"][0]["label"] = "Different target"
    with pytest.raises(ApiError) as exc:
        service.create(row["run_id"], body)
    assert exc.value.code == "REVIEW_EVIDENCE_MISMATCH"


def test_target_review_late_choice_is_conflict(repo):
    row, body, service = target_review(repo)
    review = service.create(row["run_id"], body)
    repo.transition(row["run_id"], "cancelling")
    with pytest.raises(ApiError) as exc:
        service.decide(review["review_id"], "approved", selected_candidate_id="left")
    assert exc.value.status == 409


@pytest.mark.parametrize("invalid", ["reason", "duplicate", "empty_id", "bounds_type"])
def test_invalid_target_context_is_rejected_for_direct_calls(repo, invalid):
    row, body, service = target_review(repo, access_policy="READ_WRITE")
    resolution = body["target_resolution"]
    if invalid == "reason":
        resolution["reason"] = "missing"
    elif invalid == "duplicate":
        resolution["candidates"][1]["id"] = "left"
    elif invalid == "empty_id":
        resolution["candidates"][0]["id"] = ""
    else:
        resolution["candidates"][0]["bounds"]["x"] = True
    with pytest.raises(ApiError) as exc:
        service.create(row["run_id"], body)
    assert exc.value.status == 422


@pytest.mark.parametrize("refresh", [False, True])
def test_target_decision_http_persists_and_returns_runtime_fields(
    repo, tmp_path, refresh
):
    from fastapi.testclient import TestClient

    from interface_api.config import Settings
    from interface_api.main import create_app

    app = create_app(Settings(repo_root=tmp_path, _env_file=None))
    app.state.repo = repo
    client = TestClient(app)
    row, body, _ = target_review(repo)
    result = client.post(f"/v1/runs/{row['run_id']}/human-reviews", json=body)
    assert result.status_code == 201
    review = result.json()
    assert review["target_resolution"]["candidates"][0]["id"] == "left"
    payload = {"decision": "approved"}
    if refresh:
        payload["refresh_targets"] = True
    else:
        payload["selected_candidate_id"] = "right"
    result = client.post(
        f"/v1/human-reviews/{review['review_id']}/decision", json=payload
    )
    assert result.status_code == 200
    poll = client.get(f"/v1/human-reviews/{review['review_id']}").json()
    assert poll["status"] == "approved"
    assert poll["selected_candidate_id"] == (None if refresh else "right")
    assert poll["refresh_targets"] is refresh
    assert poll["access_policy"] == "READ_ONLY"
    assert poll["run_status"] == "running"


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
