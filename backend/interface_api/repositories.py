import json
import math
from datetime import datetime, timezone
from uuid import uuid4

from .artifact_validation import canonical
from .errors import ApiError


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def identifier():
    return str(uuid4())


def decode(row):
    if row is None:
        return None
    return {
        k.removesuffix("_json"): json.loads(v)
        if k.endswith("_json") and v is not None
        else v
        for k, v in dict(row).items()
    }


def page(items, page_size, page):
    total = len(items)
    page = min(page, max(1, math.ceil(total / page_size)))
    return {
        "items": items[(page - 1) * page_size : page * page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


class Repository:
    def __init__(self, db):
        self.db = db

    def get(self, table, key, value, conn=None):
        if table not in {
            "app_deployments",
            "capabilities",
            "runs",
            "artifacts",
            "capability_bindings",
            "evidence_assets",
            "artifact_assets",
        }:
            raise ValueError("Invalid table")
        if key not in {
            "app_deployment_id",
            "capability_id",
            "run_id",
            "artifact_id",
            "binding_id",
            "asset_id",
            "idempotency_key",
        }:
            raise ValueError("Invalid key")
        if conn is not None:
            row = conn.execute(
                f"SELECT * FROM {table} WHERE {key}=?", (value,)
            ).fetchone()
        else:
            with self.db.connect() as c:
                row = c.execute(
                    f"SELECT * FROM {table} WHERE {key}=?", (value,)
                ).fetchone()
        if row is None:
            raise ApiError(404, "NOT_FOUND", "Requested resource was not found")
        return decode(row)

    def rows(self, table, where="", params=(), order="created_at DESC", conn=None):
        allowed = {
            "app_deployments",
            "capabilities",
            "runs",
            "artifacts",
            "capability_bindings",
            "evidence_assets",
            "artifact_assets",
            "run_events",
        }
        if table not in allowed:
            raise ValueError("Invalid table")
        query = (
            f"SELECT * FROM {table}"
            + (f" WHERE {where}" if where else "")
            + (f" ORDER BY {order}" if order else "")
        )
        if conn is not None:
            return [decode(x) for x in conn.execute(query, params)]
        with self.db.connect() as c:
            return [decode(x) for x in c.execute(query, params)]

    def insert(self, conn, table, values):
        fields = ",".join(values)
        placeholders = ",".join("?" for _ in values)
        conn.execute(
            f"INSERT INTO {table} ({fields}) VALUES ({placeholders})",
            tuple(values.values()),
        )

    def create_deployment(self, request):
        stamp = now()
        data = {
            **request,
            "app_deployment_id": identifier(),
            "config_version": 1,
            "created_at": stamp,
            "updated_at": stamp,
        }
        data.setdefault("vendor_release", None)
        with self.db.transaction() as c:
            self.insert(c, "app_deployments", data)
        return data

    def update_deployment(self, ident, expected, patch):
        with self.db.transaction() as c:
            current = self.get("app_deployments", "app_deployment_id", ident, c)
            if current["config_version"] != expected:
                raise ApiError(
                    409, "CONFIG_VERSION_CONFLICT", "Deployment configuration changed"
                )
            current.update(patch)
            current["config_version"] += 1
            current["updated_at"] = now()
            c.execute(
                "UPDATE app_deployments SET base_url=?,environment=?,ui_variant=?,vendor_release=?,config_version=?,updated_at=? WHERE app_deployment_id=?",
                tuple(
                    current[x]
                    for x in (
                        "base_url",
                        "environment",
                        "ui_variant",
                        "vendor_release",
                        "config_version",
                        "updated_at",
                        "app_deployment_id",
                    )
                ),
            )
            return current

    def event(self, run_id, type, payload=None, step_id=None, assets=(), conn=None):
        if conn is None:
            with self.db.transaction() as c:
                return self.event(run_id, type, payload, step_id, assets, c)
        run = self.get("runs", "run_id", run_id, conn)
        seq = run["last_event_sequence"] + 1
        stamp = now()
        self.insert(
            conn,
            "run_events",
            {
                "run_id": run_id,
                "sequence": seq,
                "timestamp": stamp,
                "type": type,
                "step_id": step_id,
                "payload_json": canonical(payload or {}),
            },
        )
        for asset in assets:
            self.insert(
                conn,
                "evidence_assets",
                {**asset, "run_id": run_id, "event_sequence": seq},
            )
        conn.execute(
            "UPDATE runs SET last_event_sequence=? WHERE run_id=?", (seq, run_id)
        )
        return {
            "run_id": run_id,
            "sequence": seq,
            "timestamp": stamp,
            "type": type,
            "step_id": step_id,
            "payload": payload or {},
        }

    def new_run(
        self,
        conn,
        dep,
        kind="discovery",
        purpose="user",
        artifact=None,
        binding=None,
        task=None,
        inputs=None,
        selection="discovery",
        parent=None,
        key=None,
        request_hash=None,
    ):
        data = {
            "run_id": identifier(),
            "kind": kind,
            "purpose": purpose,
            "app_deployment_id": dep["app_deployment_id"],
            "deployment_snapshot_json": canonical(
                {k: v for k, v in dep.items() if k not in ("created_at", "updated_at")}
            ),
            "capability_id": artifact["capability_id"] if artifact else None,
            "pinned_artifact_id": artifact["artifact_id"] if artifact else None,
            "artifact_version": artifact["version"] if artifact else None,
            "artifact_definition_sha256": artifact["definition_sha256"]
            if artifact
            else None,
            "selection_source": selection,
            "binding_id": binding["binding_id"] if binding else None,
            "binding_version": binding["binding_version"] if binding else None,
            "binding_snapshot_json": canonical(binding) if binding else None,
            "parent_run_id": parent,
            "task": task,
            "inputs_json": canonical(inputs or {}),
            "status": "queued",
            "idempotency_key": key,
            "request_sha256": request_hash,
            "created_at": now(),
        }
        self.insert(conn, "runs", data)
        self.event(
            data["run_id"],
            "run_queued",
            {
                "request": {"kind": kind, "task": task, "inputs": inputs or {}},
                "purpose": purpose,
            },
            conn=conn,
        )
        return self.get("runs", "run_id", data["run_id"], conn)

    def transition(self, run_id, status, result=None, runtime=None, conn=None):
        if conn is None:
            with self.db.transaction() as c:
                return self.transition(run_id, status, result, runtime, c)
        current = self.get("runs", "run_id", run_id, conn)
        allowed = {
            "queued": {"running", "cancelled", "interrupted", "failed"},
            "running": {
                "awaiting_finalization",
                "completed",
                "failed",
                "cancelling",
                "interrupted",
            },
            "awaiting_finalization": {
                "validating",
                "failed",
                "cancelling",
                "interrupted",
            },
            "validating": {"completed", "failed", "cancelling", "interrupted"},
            "cancelling": {"cancelled", "interrupted"},
            "failed": {"validating"},
            "interrupted": {"validating"},
        }
        if status == current["status"]:
            return current
        if status not in allowed.get(current["status"], set()):
            raise ApiError(
                409, "RUN_STATUS_CONFLICT", "Run status does not permit this transition"
            )
        stamp = now()
        terminal = status in ("completed", "failed", "cancelled", "interrupted")
        conn.execute(
            "UPDATE runs SET status=?,started_at=COALESCE(started_at,?),finished_at=?,result_json=?,runtime_result_json=COALESCE(?,runtime_result_json) WHERE run_id=?",
            (
                status,
                stamp if status == "running" else None,
                stamp if terminal else None,
                canonical(result) if result else None,
                canonical(runtime) if runtime else None,
                run_id,
            ),
        )
        event = "run_started" if status == "running" else "run_" + status
        self.event(run_id, event, result or {}, conn=conn)
        return self.get("runs", "run_id", run_id, conn)
