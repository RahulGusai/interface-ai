from .errors import ApiError
from .repositories import page


class Reads:
    def __init__(self, repo):
        self.repo = repo

    def capability(self, row):
        ident = row["capability_id"]
        counts = {}
        for key, table, where in [
            (
                "published_artifacts",
                "artifacts",
                "capability_id=? AND state='published'",
            ),
            (
                "ready_bindings",
                "capability_bindings",
                "capability_id=? AND state='ready'",
            ),
            ("runs", "runs", "capability_id=?"),
        ]:
            with self.repo.db.connect() as c:
                counts[key] = c.execute(
                    f"SELECT count(*) FROM {table} WHERE {where}", (ident,)
                ).fetchone()[0]
        return {**row, "counts": counts}

    def run(self, row):
        result = row.get("result") or {}
        events = self.repo.rows(
            "run_events", "run_id=?", (row["run_id"],), "sequence DESC"
        )
        steps = [x for x in events if x["type"] in ("tool_finished", "wait_condition_satisfied") and x["step_id"]]
        total = None
        if row["pinned_artifact_id"]:
            total = len(
                self.repo.get("artifacts", "artifact_id", row["pinned_artifact_id"])[
                    "definition"
                ]["steps"]
            )
        data = {
            k: v
            for k, v in row.items()
            if k
            not in (
                "result",
                "idempotency_key",
                "request_sha256",
                "last_event_sequence",
            )
        }
        data.update(
            outcome=result.get("outcome"),
            stop_reason=result.get("stop_reason"),
            progress={
                "last_event_sequence": row["last_event_sequence"],
                "current_step_id": next(
                    (e["step_id"] for e in events if e["step_id"]), None
                ),
                "completed_steps": len(
                    {
                        e["step_id"]
                        for e in steps
                        if e["payload"].get("dispatch_state") == "completed" or e["type"] == "wait_condition_satisfied"
                    }
                )
                if total is not None
                else None,
                "total_steps": total,
            },
        )
        return data

    def compatible(self, artifact, deployment):
        meta = artifact["definition"]["compatibility"]
        return (
            meta["product_id"] == deployment["product_id"]
            and meta["ui_variant"] == deployment["ui_variant"]
            and meta["vendor_release"] == deployment["vendor_release"]
        )

    def eligibility(self, artifact, deployment):
        source = self.repo.get("runs", "run_id", artifact["source_run_id"])
        if source["app_deployment_id"] != deployment["app_deployment_id"]:
            return {
                "state": "incompatible",
                "reason": "Cross-deployment validation is deferred",
                "validation_run_id": None,
            }
        if not self.compatible(artifact, deployment):
            return {
                "state": "incompatible",
                "reason": "Deployment metadata differs",
                "validation_run_id": None,
            }
        candidates = self.repo.rows(
            "runs",
            "pinned_artifact_id=? AND purpose='validation' AND status='completed'",
            (artifact["artifact_id"],),
            "created_at DESC,run_id DESC",
        )
        for run in candidates:
            result = run.get("result") or {}
            if (
                run["deployment_snapshot"]["config_version"]
                == deployment["config_version"]
                and run["artifact_definition_sha256"] == artifact["definition_sha256"]
                and result.get("validated_definition_sha256")
                == artifact["definition_sha256"]
                and result.get("outcome", {}).get("kind") == "success"
            ):
                return {
                    "state": "ready",
                    "reason": "Validated at current configuration; fresh entry checks still required",
                    "validation_run_id": run["run_id"],
                }
        return {
            "state": "validation_needed",
            "reason": "Current configuration requires validation",
            "validation_run_id": None,
        }

    def binding(self, row):
        artifact = self.repo.get("artifacts", "artifact_id", row["artifact_id"])
        dep = self.repo.get(
            "app_deployments", "app_deployment_id", row["app_deployment_id"]
        )
        ready = self.eligibility(artifact, dep)
        if row["state"] == "retired":
            ready = {
                "state": "validation_needed",
                "reason": "Binding retired",
                "validation_run_id": ready["validation_run_id"],
            }
        return {**row, "readiness": ready}

    def artifact(self, row, detail=False):
        artifact_id = row["artifact_id"]
        source = self.repo.get("runs", "run_id", row["source_run_id"])
        publication = (source.get("result") or {}).get(
            "publication", {"binding_action": None, "binding_id": None}
        )
        data = {
            k: v
            for k, v in row.items()
            if k not in ("definition", "capability_proposal")
        }
        data.update(
            compatibility=row["definition"]["compatibility"],
            publication=publication,
            lineage={
                "source_run_id": row["source_run_id"],
                "validation_runs": [
                    x["run_id"]
                    for x in self.repo.rows(
                        "runs",
                        "pinned_artifact_id=? AND purpose='validation'",
                        (artifact_id,),
                        "created_at ASC,run_id ASC",
                    )
                ],
                "replay_count": len(
                    self.repo.rows(
                        "runs",
                        "pinned_artifact_id=? AND purpose='user'",
                        (artifact_id,),
                    )
                ),
            },
        )
        if detail:
            data.update(
                definition=row["definition"],
                assets=self.repo.rows(
                    "artifact_assets",
                    "artifact_id=?",
                    (artifact_id,),
                    "created_at ASC,asset_id ASC",
                ),
            )
        return data

    def collection(
        self,
        table,
        filters,
        number,
        size,
        q=None,
        order_by="created_at",
        direction="desc",
        allowed=("created_at",),
        projection=None,
    ):
        if order_by not in allowed or direction not in ("asc", "desc"):
            raise ApiError(422, "SORT_INVALID", "Unsupported ordering")
        rows = self.repo.rows(table, order="")
        for key, value in filters.items():
            if value is None:
                continue
            if table == "runs" and key == "artifact_id":
                rows = [
                    r
                    for r in rows
                    if value in (r["pinned_artifact_id"], r["finalized_artifact_id"])
                ]
            elif table == "artifacts" and key in ("product_id", "ui_variant"):
                rows = [
                    r for r in rows if r["definition"]["compatibility"][key] == value
                ]
            else:
                rows = [r for r in rows if r.get(key) == value]
        if q:
            text = q.casefold()
            rows = [
                r
                for r in rows
                if any(
                    text in str(r.get(k, "")).casefold()
                    for k in (
                        "task",
                        "name",
                        "description",
                        "label",
                        "artifact_id",
                        "tenant_id",
                        "product_id",
                    )
                )
                or table == "artifacts"
                and text
                in str(r["definition"]["compatibility"]["ui_variant"]).casefold()
            ]
        id_key = {
            "app_deployments": "app_deployment_id",
            "capabilities": "capability_id",
            "runs": "run_id",
            "artifacts": "artifact_id",
            "capability_bindings": "binding_id",
            "evidence_assets": "asset_id",
            "artifact_assets": "asset_id",
        }[table]
        rows.sort(
            key=lambda r: (r.get(order_by) or "", r.get("created_at", ""), r[id_key]),
            reverse=direction == "desc",
        )
        if order_by == "started_at":
            rows = [r for r in rows if r["started_at"]] + [
                r for r in rows if not r["started_at"]
            ]
        result = page(rows, size, number)
        if projection:
            result["items"] = [projection(r) for r in result["items"]]
        return result

    def events(self, run_id, after, limit, event_type=None):
        run = self.repo.get("runs", "run_id", run_id)
        if after < 0:
            raise ApiError(400, "CURSOR_INVALID", "Cursor cannot be negative")
        # Scan sequence window, even when all events are filtered out.
        with self.repo.db.connect() as c:
            from .repositories import decode

            rows = [
                decode(r)
                for r in c.execute(
                    "SELECT * FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?",
                    (run_id, after, limit),
                )
            ]
        cursor = rows[-1]["sequence"] if rows else after
        return {
            "items": [r for r in rows if event_type is None or r["type"] == event_type],
            "next_after_sequence": cursor,
            "has_more": cursor < run["last_event_sequence"],
            "run_status": run["status"],
        }
