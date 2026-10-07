import asyncio
import shutil

from .evidence import Evidence
from .maintenance import TERMINAL, sweep_staging


class Worker:
    def __init__(self, repo, settings, storage, runner):
        self.repo, self.settings, self.storage, self.runner = (
            repo,
            settings,
            storage,
            runner,
        )
        self.queue = asyncio.Queue(maxsize=16)
        self.admission = asyncio.Lock()
        self.accepting = True
        self.task = None
        self.active = None
        self.cancel_signal = None
        self.lifecycle = None

    def startup_reconcile(self, code="PROCESS_RESTARTED"):
        with self.repo.db.transaction() as c:
            rows = self.repo.rows(
                "runs",
                "status NOT IN ('completed','failed','cancelled','interrupted')",
                conn=c,
            )
            for row in rows:
                self.repo.transition(
                    row["run_id"],
                    "interrupted",
                    {
                        "stop_reason": {
                            "code": code,
                            "dispatch_state": "uncertain"
                            if row["status"] != "queued"
                            else "not_dispatched",
                        }
                    },
                    conn=c,
                )
            c.execute(
                "UPDATE artifacts SET state='validation_failed' WHERE state IN ('draft','validating')"
            )
        sweep_staging(self.repo, self.settings.database_path.parent / "staging")
        return len(rows)

    async def start(self):
        await asyncio.to_thread(self.startup_reconcile)
        self.task = asyncio.create_task(self.loop())

    async def loop(self):
        while True:
            ident = await self.queue.get()
            try:
                row = await asyncio.to_thread(self.repo.get, "runs", "run_id", ident)
                if row["status"] == "queued" and self.accepting:
                    self.active = ident
                    self.cancel_signal = asyncio.Event()
                    if self.lifecycle:
                        await self.lifecycle.execute(ident)
                    else:
                        await self.execute_raw(ident)
            except asyncio.CancelledError:
                raise
            except Exception:
                await self.fail(ident, "RUNNER_EXECUTION_FAILED")
            finally:
                self.active = None
                self.cancel_signal = None
                self.queue.task_done()

    async def fail(self, ident, code, stage="execution"):
        row = await asyncio.to_thread(self.repo.get, "runs", "run_id", ident)
        if row["status"] in TERMINAL:
            return
        if row["status"] == "cancelling":
            await asyncio.to_thread(
                self.repo.transition,
                ident,
                "cancelled",
                {
                    "stop_reason": {
                        "code": "USER_CANCELLED",
                        "dispatch_state": "uncertain",
                    }
                },
            )
            return
        await asyncio.to_thread(
            self.repo.transition,
            ident,
            "failed",
            {
                "outcome": {
                    "kind": "hard_failure",
                    "code": code,
                    "message": "Execution stopped; inspect recorded events",
                    "outputs": None,
                    "failure_stage": stage,
                    "step_id": None,
                    "expected": None,
                    "observed": None,
                    "dispatch_state": "uncertain",
                }
            },
        )

    async def execute_raw(self, ident):
        current = await asyncio.to_thread(self.repo.get, "runs", "run_id", ident)
        if current["status"] != "queued":
            return None
        if not self.accepting:
            await asyncio.to_thread(
                self.repo.transition,
                ident,
                "interrupted",
                {
                    "stop_reason": {
                        "code": "SERVICE_SHUTDOWN",
                        "dispatch_state": "not_dispatched",
                    }
                },
            )
            return None
        if self.cancel_signal and self.cancel_signal.is_set():
            await asyncio.to_thread(
                self.repo.transition,
                ident,
                "cancelled",
                {
                    "stop_reason": {
                        "code": "USER_CANCELLED",
                        "dispatch_state": "not_dispatched",
                    }
                },
            )
            return None
        row = await asyncio.to_thread(self.repo.transition, ident, "running")
        staging = self.settings.database_path.parent / "staging" / ident
        staging.mkdir(parents=True, exist_ok=True, mode=0o700)
        assets = []
        artifact = None
        try:
            if row["pinned_artifact_id"]:
                artifact = await asyncio.to_thread(
                    self.repo.get, "artifacts", "artifact_id", row["pinned_artifact_id"]
                )
                for asset in await asyncio.to_thread(
                    self.repo.rows,
                    "artifact_assets",
                    "artifact_id=?",
                    (artifact["artifact_id"],),
                    "created_at ASC",
                ):
                    data = await asyncio.wait_for(
                        asyncio.to_thread(
                            self.storage.get_png, asset["object_key"], asset["sha256"]
                        ),
                        20,
                    )
                    name = asset["asset_id"] + ".png"
                    path = staging / name
                    path.write_bytes(data)
                    path.chmod(0o600)
                    assets.append(
                        {
                            "asset_id": asset["asset_id"],
                            "staged_path": name,
                            "sha256": asset["sha256"],
                        }
                    )
            command = {
                "protocol_version": 1,
                "type": "start",
                "run_id": ident,
                "mode": row["kind"],
                "deployment": row["deployment_snapshot"],
                "task": row["task"],
                "inputs": row["inputs"],
                "capability_catalog": await asyncio.to_thread(
                    self.repo.rows, "capabilities"
                ),
                "artifact": artifact,
                "assets": assets,
                "staging_directory": str(staging),
                "runtime": {
                    "headless": self.settings.headless,
                    "max_tool_calls": self.settings.max_tool_calls,
                },
            }
            sink = Evidence(self.repo, self.storage)

            async def persist(message):
                if message["type"] == "event":
                    return await sink.persist(
                        ident, message["event"], message["assets"], staging
                    )
                event = await asyncio.to_thread(
                    self.repo.event,
                    ident,
                    "runner_completed",
                    {
                        "runtime_result": message["runtime_result"],
                        "discovery_proposal": message.get("discovery_proposal"),
                    },
                )
                return {"event_sequence": event["sequence"], "continue": True}

            result = await self.runner.run(command, persist, self.cancel_signal)
            if self.cancel_signal.is_set():
                current = await asyncio.to_thread(
                    self.repo.get, "runs", "run_id", ident
                )
                if current["status"] == "cancelling":
                    await asyncio.to_thread(
                        self.repo.transition,
                        ident,
                        "cancelled",
                        {
                            "stop_reason": {
                                "code": "USER_CANCELLED",
                                "dispatch_state": result["runtime_result"].get(
                                    "dispatch_state", "uncertain"
                                ),
                            }
                        },
                    )
                return None
            return result
        except Exception as exc:
            code = (
                "STORAGE_UPLOAD_FAILED"
                if str(exc) == "STORAGE_UPLOAD_FAILED"
                else "RUNNER_EXITED"
                if str(exc) == "RUNNER_EXITED"
                else "RUNNER_PROTOCOL_ERROR"
            )
            await self.fail(
                ident,
                code,
                "storage" if code == "STORAGE_UPLOAD_FAILED" else "execution",
            )
            return None
        finally:
            # Proposal crop files survive until lifecycle imports them. Terminal cleanup happens there.
            if artifact:
                shutil.rmtree(staging, ignore_errors=True)

    async def cancel(self, ident):
        def mark():
            with self.repo.db.transaction() as c:
                row = self.repo.get("runs", "run_id", ident, c)
                active = (
                    self.repo.get("runs", "run_id", self.active, c)
                    if self.active
                    else None
                )
                affects_active = bool(
                    active
                    and (
                        active["run_id"] == ident
                        or active.get("parent_run_id") == ident
                        or row.get("parent_run_id") == active["run_id"]
                    )
                )
                if row["status"] in ("cancelled", "cancelling"):
                    return row, affects_active
                if row["status"] in TERMINAL:
                    from .errors import ApiError

                    raise ApiError(
                        409, "RUN_NOT_CANCELLABLE", "Run is already terminal"
                    )
                status = "cancelled" if row["status"] == "queued" else "cancelling"
                reason = {
                    "stop_reason": {
                        "code": "USER_CANCELLED",
                        "dispatch_state": "not_dispatched",
                    }
                }
                self.repo.transition(
                    ident, status, reason if status == "cancelled" else None, conn=c
                )
                children = self.repo.rows(
                    "runs",
                    "parent_run_id=? AND status IN ('queued','running','cancelling')",
                    (ident,),
                    conn=c,
                )
                for child in children:
                    if child["status"] in ("queued", "running"):
                        self.repo.transition(
                            child["run_id"],
                            "cancelled"
                            if child["status"] == "queued"
                            else "cancelling",
                            reason if child["status"] == "queued" else None,
                            conn=c,
                        )
                # Queued validation tombstones have no child execution to settle their bundle.
                if children and not any(
                    child["status"] in ("running", "cancelling") for child in children
                ):
                    self.repo.transition(ident, "cancelled", reason, conn=c)
                    c.execute(
                        "UPDATE artifacts SET state='validation_failed' WHERE source_run_id=? AND state!='published'",
                        (ident,),
                    )
                if (
                    row["purpose"] == "validation"
                    and status == "cancelled"
                    and self.lifecycle
                ):
                    artifact = self.repo.get(
                        "artifacts", "artifact_id", row["pinned_artifact_id"], c
                    )
                    if artifact["state"] != "published":
                        self.lifecycle.validation_failed(
                            artifact, ident, reason, conn=c
                        )
                return self.repo.get("runs", "run_id", ident, c), affects_active

        row, affects_active = await asyncio.to_thread(mark)
        if affects_active and self.cancel_signal:
            self.cancel_signal.set()
        return row

    async def shutdown(self):
        # Close admission before yielding; the loop never dispatches another pending ID.
        self.accepting = False
        async with self.admission:

            def interrupt_pending():
                with self.repo.db.transaction() as c:
                    for row in self.repo.rows("runs", "status='queued'", conn=c):
                        self.repo.transition(
                            row["run_id"],
                            "interrupted",
                            {
                                "stop_reason": {
                                    "code": "SERVICE_SHUTDOWN",
                                    "dispatch_state": "not_dispatched",
                                }
                            },
                            conn=c,
                        )

            await asyncio.to_thread(interrupt_pending)
        if self.cancel_signal:
            self.cancel_signal.set()
        if self.task:
            try:
                await asyncio.wait_for(self.queue.join(), 15)
            except asyncio.TimeoutError:
                pass
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await asyncio.to_thread(self.startup_reconcile, "SERVICE_SHUTDOWN")
