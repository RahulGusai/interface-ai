"""Durable review decisions; the browser and suspended execution stay in Node."""

from datetime import datetime, timedelta, timezone

from .artifact_validation import canonical, digest
from .dto import ExecutionAssessment, HumanReviewCreate, HumanReviewDecision
from .errors import ApiError
from .repositories import now


class Reviews:
    def __init__(self, repo, timeout_seconds=300):
        self.repo = repo
        self.timeout_seconds = timeout_seconds

    def _expire(self, c):
        for row in self.repo.rows(
            "human_review", "status='pending' AND expires_at<=?", (now(),), conn=c
        ):
            c.execute(
                "UPDATE human_review SET status='expired',decided_at=? WHERE review_id=?",
                (now(), row["review_id"]),
            )
            self.repo.event(
                row["run_id"],
                "human_review_expired",
                {"review_id": row["review_id"]},
                conn=c,
            )

    def _view(self, row, c):
        return {k: v for k, v in row.items() if k != "request_sha256"} | {
            "run_status": self.repo.get("runs", "run_id", row["run_id"], c)["status"],
            "refresh_targets": bool(row["refresh_targets"]),
        }

    def create(self, run_id, body):
        with self.repo.db.transaction() as c:
            self._expire(c)
            run = self.repo.get("runs", "run_id", run_id, c)
            if run["access_policy"] != "READ_WRITE" and not body.get(
                "target_resolution"
            ):
                raise ApiError(
                    409,
                    "REVIEW_NOT_ALLOWED",
                    "Read-only runs require target resolution",
                )
            try:
                body = HumanReviewCreate.model_validate(body).model_dump(
                    mode="json", exclude_unset=True
                )
            except ValueError as error:
                raise ApiError(
                    422, "REQUEST_INVALID", "Invalid review request"
                ) from error
            if body.get("target_resolution") is None:
                body.pop("target_resolution", None)
            request_hash = digest(body)
            old = self.repo.rows(
                "human_review", "review_id=?", (body["review_id"],), conn=c
            )
            if old:
                if (
                    old[0]["run_id"] != run_id
                    or old[0]["request_sha256"] != request_hash
                ):
                    raise ApiError(
                        409,
                        "REVIEW_CONFLICT",
                        "Review ID was used for a different action",
                    )
                return self._view(old[0], c)
            if run["status"] != "running":
                raise ApiError(409, "RUN_NOT_REVIEWABLE", "Run must be running")
            if self.repo.rows(
                "human_review", "run_id=? AND status='pending'", (run_id,), conn=c
            ):
                raise ApiError(
                    409, "REVIEW_PENDING", "Run already has a pending review"
                )
            events = self.repo.rows(
                "run_events",
                "run_id=? AND sequence=? AND type='human_review_snapshot'",
                (run_id, body["event_sequence"]),
                order="",
                conn=c,
            )
            if not events or any(
                events[0]["payload"].get(key) != body.get(key)
                for key in (
                    "call_id",
                    "tool",
                    "arguments",
                    "assessment",
                    "state_fingerprint",
                    "target_resolution",
                )
            ):
                raise ApiError(
                    409,
                    "REVIEW_EVIDENCE_MISMATCH",
                    "Review must reference its persisted action snapshot",
                )
            assets = self.repo.rows(
                "evidence_assets",
                "run_id=? AND event_sequence=?",
                (run_id, body["event_sequence"]),
                order="",
                conn=c,
            )
            if not assets:
                raise ApiError(
                    409,
                    "REVIEW_EVIDENCE_MISSING",
                    "Review requires a persisted screenshot",
                )
            resolution = body.get("target_resolution")
            if resolution is not None:
                width, height = assets[0]["width"], assets[0]["height"]
                if (
                    width is None
                    or height is None
                    or any(
                        candidate["bounds"]["x"] + candidate["bounds"]["width"] > width
                        or candidate["bounds"]["y"] + candidate["bounds"]["height"]
                        > height
                        for candidate in resolution["candidates"]
                    )
                ):
                    raise ApiError(
                        422,
                        "INVALID_TARGET_BOUNDS",
                        "Candidates must fit the persisted screenshot",
                    )
            try:
                assessment = ExecutionAssessment.model_validate(
                    body.get("assessment")
                ).model_dump()
            except ValueError:
                assessment = None
            stamp = now()
            data = {
                "review_id": body["review_id"],
                "run_id": run_id,
                "call_id": body["call_id"],
                "tool": body["tool"],
                "arguments_json": canonical(body["arguments"]),
                "assessment_decision": assessment["decision"] if assessment else None,
                "confidence": assessment["confidence"] if assessment else None,
                "reason": assessment["reason"]
                if assessment
                else "Missing or invalid execution assessment",
                "access_policy": run["access_policy"],
                "screenshot_asset_id": assets[0]["asset_id"],
                "event_sequence": body["event_sequence"],
                "state_fingerprint": body["state_fingerprint"],
                "request_sha256": request_hash,
                "status": "pending",
                "created_at": stamp,
                "expires_at": (
                    datetime.now(timezone.utc) + timedelta(seconds=self.timeout_seconds)
                )
                .isoformat()
                .replace("+00:00", "Z"),
                "decided_at": None,
                "human_comment": None,
                "target_resolution_json": canonical(resolution)
                if resolution is not None
                else None,
                "selected_candidate_id": None,
                "refresh_targets": False,
            }
            self.repo.insert(c, "human_review", data)
            self.repo.transition(run_id, "awaiting_human", conn=c)
            self.repo.event(
                run_id,
                "human_review_requested",
                {"review_id": body["review_id"], "call_id": body["call_id"]},
                conn=c,
            )
            return self._view(
                self.repo.get("human_review", "review_id", body["review_id"], c), c
            )

    def get(self, review_id):
        with self.repo.db.transaction() as c:
            self._expire(c)
            return self._view(
                self.repo.get("human_review", "review_id", review_id, c), c
            )

    def list(self, status=None, run_id=None):
        with self.repo.db.transaction() as c:
            self._expire(c)
            clauses, args = [], []
            for key, value in [("status", status), ("run_id", run_id)]:
                if value is not None:
                    clauses.append(key + "=?")
                    args.append(value)
            return [
                self._view(r, c)
                for r in self.repo.rows(
                    "human_review", " AND ".join(clauses), tuple(args), conn=c
                )
            ]

    def decide(
        self,
        review_id,
        decision,
        comment=None,
        selected_candidate_id=None,
        refresh_targets=False,
    ):
        # Expiry commits separately even when a late decision is rejected.
        self.get(review_id)
        with self.repo.db.transaction() as c:
            row = self.repo.get("human_review", "review_id", review_id, c)
            run = self.repo.get("runs", "run_id", row["run_id"], c)
            try:
                HumanReviewDecision.model_validate(
                    {
                        "decision": decision,
                        "comment": comment,
                        "selected_candidate_id": selected_candidate_id,
                        "refresh_targets": refresh_targets,
                    }
                )
            except ValueError as error:
                raise ApiError(
                    422, "INVALID_REVIEW_DECISION", "Invalid review decision"
                ) from error
            if (
                row["status"] == decision
                and row["human_comment"] == comment
                and row["selected_candidate_id"] == selected_candidate_id
                and bool(row["refresh_targets"]) == refresh_targets
            ):
                return self._view(row, c)
            if (
                row["status"] != "pending"
                or run["status"] != "awaiting_human"
                or row["expires_at"] <= now()
            ):
                raise ApiError(409, "REVIEW_CONCLUDED", "Review is no longer pending")
            resolution = row["target_resolution"]
            if resolution is None and (
                selected_candidate_id is not None or refresh_targets
            ):
                raise ApiError(
                    422,
                    "INVALID_REVIEW_DECISION",
                    "Approval review cannot select targets",
                )
            if resolution is not None and decision == "approved":
                if selected_candidate_id is None and not refresh_targets:
                    raise ApiError(
                        422,
                        "INVALID_REVIEW_DECISION",
                        "Select a candidate or refresh targets",
                    )
                if selected_candidate_id is not None and selected_candidate_id not in {
                    candidate["id"] for candidate in resolution["candidates"]
                }:
                    raise ApiError(
                        422, "INVALID_REVIEW_DECISION", "Unknown target candidate"
                    )
            c.execute(
                "UPDATE human_review SET status=?,decided_at=?,human_comment=?,"
                "selected_candidate_id=?,refresh_targets=? WHERE review_id=?",
                (
                    decision,
                    now(),
                    comment,
                    selected_candidate_id,
                    refresh_targets,
                    review_id,
                ),
            )
            self.repo.event(
                row["run_id"],
                "human_review_decided",
                {
                    "review_id": review_id,
                    "decision": decision,
                    "human_comment": comment,
                    "target_resolution": resolution,
                    "selected_candidate_id": selected_candidate_id,
                    "refresh_targets": refresh_targets,
                },
                conn=c,
            )
            if decision == "approved":
                self.repo.transition(row["run_id"], "running", conn=c)
            return self._view(
                self.repo.get("human_review", "review_id", review_id, c), c
            )
