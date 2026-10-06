# In-memory worker and Python–Node bridge implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. No human intervention/ownership subsystem belongs in this plan.

**Goal:** Execute persisted runs through the existing TypeScript engine with truthful progress, cancellation and crash results.
**Architecture:** One asyncio.Queue and worker, one supervised child per execution, JSONL commands/events with durable ACK backpressure. SQLite is the source of run/event records, not a durable queue.
**Tech stack:** asyncio/subprocess, Node/tsx, existing runTask/dispatchTool, PNG staging.
**Spec:** [00](00-context-and-index.md), [03](03-minio-and-evidence.md), [05](05-discovery-and-publication.md), [07](07-api-contracts.md).

## Global constraints

One active run/browser; no Redis/Celery/requeue-on-start. Python controls process lifetime and storage, Node controls browser/model/tools. Start API returns 202. Keep existing runtime protections. `request_human` may still stop the existing runtime; map that stop to a failed run, never create a handoff request/endpoint. No pause/resume/takeover actions.

## Review focus

Child exit without a terminal message is failure, not success. Lost ACK stops execution before another action. Cancellation during a model call must prevent subsequent proposed tools from dispatching. Already dispatched mutations cannot be undone or retried. Process-death queued runs are interrupted, not recovered.

## Task 1: Minimal protocol v1 and Node CLI

**Files:** Create `src/bridge/{protocol,runner-cli,transport,staging}.ts`, `backend/interface_api/bridge.py`, `tests/unit/bridge-protocol.test.ts`, `backend/tests/test_bridge.py`. Modify `src/runtime/audit.ts`, `src/runtime/run-task.ts`, `src/llm/{model-client,openrouter-client}.ts` only at explicit async/cancellation seams. Current demo CLI and synchronous file audit remain supported.
**Interfaces:** `runTask(raw,deps,options)` gains `signal?:AbortSignal`, `onAudit?: (record,image?)=>void|Promise<void>`, and optional discovery context (05). `ModelClient.complete(messages,tools,options?:{signal?:AbortSignal})`. `run_child(command: StartCommand, sink: AsyncEventSink, controls: AsyncIterator[ControlCommand]) -> RunnerCompletion`.

Pipe protocol: UTF-8 one JSON object per line, stdout protocol only; stderr sanitized diagnostics, drained concurrently. Version field required and unknown message types reject. Max metadata line 1 MiB; image bytes use staging (03). No shell; argv paths owned by service. Python owns UUID run ID; Node child may only emit for that ID.

Python -> Node:

```json
{"protocol_version":1,"type":"start","run_id":"<uuid>","mode":"discovery","deployment":{"app_deployment_id":"<uuid>","config_version":1,"product_id":"memberdesk","base_url":"http://127.0.0.1:4173","environment":"demo","ui_variant":"standard-v1","vendor_release":null},"task":"Look up synthetic member demo@example.test","inputs":{},"capability_catalog":[],"artifact":null,"staging_directory":"<trusted-absolute-path>"}
```

Replay substitutes `mode:"replay"`, `task:null`, typed `inputs`, and exact frozen `artifact` including its ID/version/hash (version may be null on validation draft); no model constructed in replay. Start contains trusted runtime policy/config references from server configuration, never client-supplied policy. Credentials inherited in a minimal child environment, not serialized in start/events or argv.

Other commands:

```json
{"protocol_version":1,"type":"ack","run_id":"<uuid>","message_seq":4,"event_sequence":7,"continue":true}
{"protocol_version":1,"type":"cancel","run_id":"<uuid>","reason":"user_cancelled"}
```

Node -> Python:

```json
{"protocol_version":1,"type":"ready","run_id":"<uuid>"}
{"protocol_version":1,"type":"event","run_id":"<uuid>","message_seq":4,"event":{"type":"tool_finished","step_id":null,"payload":{"call_id":"fresh-call","tool":"click","result":{"status":"completed"},"dispatch_state":"completed"}},"assets":[{"staged_path":"shot.png","kind":"post_tool_screenshot","sha256":"<digest>","width":1280,"height":800,"captured_at":"2026-10-07T00:00:00Z"}]}
{"protocol_version":1,"type":"completed","run_id":"<uuid>","message_seq":5,"runtime_result":{"status":"awaiting_artifact_design"},"discovery_proposal":null}
```

`completed` is a proposal/runner terminal envelope, not an API completed status; 05 publishes only after validation. Completed messages are acknowledged after their data is persisted too. `discovery_proposal` details in 05. Node event payload captures current sanitized inputs/results/errors exactly, including observation/control/call IDs. Timestamp is captured by Python commit; Node captured_at is metadata. DB sequence is authoritative; message_seq is transport ordering only and is never artifact step provenance.

- [ ] Tests: reject version mismatch, wrong run ID, invalid JSON, >1MiB metadata and out-of-order message_seq; consume split lines correctly. A fake child emits event then waits: no next event/action until committed ACK.
- [ ] Node emits ready after validating start, before creating browser. Python waits <=10 seconds for ready. One unacknowledged event at a time; ACK timeout 30 seconds, no retransmit/automatic dispatch retry. Metadata DB persistence and bounded image upload must finish within ACK window; recommend storage whole-operation deadline20 seconds plus DB busy5 seconds; storage failure returns continue=false. Uncertain ACK causes terminal runner failure and supervisor cleanup, not fabricated duplicate events.
- [ ] Await audit sink at run/tool-start/finish and final result boundaries. Existing synchronous createFileAudit still works because await accepts void; await calls inside stop() and catches. Diagnostic onEvent remains best-effort, never persisted as the authoritative tool log.
- [ ] Tool_started is committed before dispatch; tool_finished + projected screenshot before next model/tool action. Retain existing ConversationHistory multimodal messages with observation_id, preceding_call_id, image_ref and actual inline bytes. Storage upload does not replace memory history.
- [ ] Gate: existing history/audit/runtime tests pass with synchronous sink; async sink failure prevents next dispatch. Node CLI stdout contains only parseable protocol messages, no provider config/keys.

## Task 2: Queue, supervision and honest restart

**Files:** `backend/interface_api/worker.py`, `services.py`, `backend/tests/test_worker.py`.
**Interfaces:** `enqueue(run_id: str) -> None`; `execute_job(run_id: str) -> None`; `request_cancel(run_id: str) -> RunRecord`; `startup_reconcile() -> int`; `shutdown(grace_seconds: int=15) -> None`.

- [ ] Queue capacity 16 pending jobs, worker concurrency 1. Admission lock spans capacity check -> DB run + run_queued commit -> queue put_nowait, with no await between commit and enqueue. If enqueue nevertheless fails, mark admitted run failed with QUEUE_ADMISSION_FAILED. Crash in that gap is reconciled at startup. Full queue returns 503 QUEUE_FULL before creating a run; idempotency lookup occurs before capacity check.
- [ ] Worker dequeues ID, CAS queued -> running with started_at and run_started event, spawns child. Cancelled queued IDs are harmless tombstones skipped when dequeued. Worker never holds a DB transaction while waiting for child/network.
- [ ] Validate every child envelope; supervise process exit, protocol stream, cancel and startup timeout concurrently. Drain stderr to avoid deadlock but retain only bounded sanitized tail. No general run watchdog/budget beyond existing maxToolCalls/browser/model deadlines; inactivity while 120s model call is legitimate. Process exit/protocol failure produces RUNNER_EXITED / RUNNER_PROTOCOL_ERROR with last step/dispatch uncertainty.
- [ ] Spawn in a new process group/session so forced cleanup kills Node and Chromium descendants. Always await child reaping. Do not infer success from exit 0 without valid terminal result or finalization gate.
- [ ] Startup marks all queued/running/cancelling/awaiting_finalization/validating source and validation jobs from the previous service lifetime `interrupted`, with PROCESS_RESTARTED and run_interrupted event; mark affected draft validation_failed. No re-enqueue/browser resume. Published completed runs remain completed. Later retry is a new run, except an explicit revalidation request on a frozen draft (07); it is never automatic.
- [ ] Graceful shutdown rejects new starts, marks queued runs interrupted, requests cancellation of active child, allows <=15 seconds for settling and evidence persistence, then SIGTERM group, 2 seconds then SIGKILL. Persist interrupted/SERVICE_SHUTDOWN (not user cancelled) for unfinished jobs. Node pipe EOF triggers child cleanup/adapter close. Abrupt SIGKILL can lose last in-flight result; mark uncertainty on next start.
- [ ] Gate tests: two jobs never dispatch concurrently; fake child crash persists failure; restart marks queued/running interrupted; published artifact unaffected; process group leaves no browser child after bounded shutdown.

## Task 3: Cancellation without handoff

**Files:** `worker.py`, `bridge.py`, `src/runtime/run-task.ts`, `src/llm/openrouter-client.ts`, `tests/unit/run-task.test.ts`, `backend/tests/test_cancellation.py`.

- [ ] POST cancel is idempotent for cancelled/cancelling; completed/failed/interrupted is 409 RUN_NOT_CANCELLABLE. Queued cancellation commits cancelled immediately. Active cancellation commits cancelling, sends cancel, and waits asynchronously; HTTP returns 202 current DTO. No pause/return API.
- [ ] Combine external AbortSignal with existing 120000ms model timeout; abort provider HTTP promptly. Check signal before/after every model await and before each tool in a proposed batch. Discard remaining proposals and record tool_not_executed reason cancelled.
- [ ] Browser action already dispatched is allowed to settle under its existing operation deadline until shutdown/cancellation cleanup deadline 15 seconds. If it cannot settle, kill child and record dispatch_state uncertain. Never auto-retry mutation. Node closes adapter in finally, exactly as normal terminal handling does today.
- [ ] Cancel during validation prevents publication via SQLite status/hash check. Publication and cancel linearize under one transaction: if publication committed first, cancel returns terminal conflict; if cancel committed first, publication aborts. Cancellation of a discovery bundle also cancels its active validation child/run.
- [ ] Gate: fake provider resolves after cancellation but tool spy stays zero; cancel during dispatched mutation produces one dispatch maximum and explicit settled/uncertain result; no child/session kept alive for human control.
