# Interface AI backend and frontend planning index

Date: 2026-10-07 (Asia/Kolkata). **Documentation only. Nothing in this pack is implemented by writing it.** Future execution requires a separate implementation request. No Lovable messages, infrastructure provisioning, publishing, deployment, or source-code changes are part of this planning task.

## Reading and execution order

| File | Responsibility |
|---|---|
| [01-schema-and-migrations.md](01-schema-and-migrations.md) | Eight logical tables, invariants, migrations, DB persistence and backups |
| [02-service-and-configuration.md](02-service-and-configuration.md) | Minimal FastAPI service, process/configuration layout, CORS, local/Railway execution seam |
| [03-minio-and-evidence.md](03-minio-and-evidence.md) | Private objects, evidence persistence, reference assets and signed URLs |
| [04-worker-and-node-bridge.md](04-worker-and-node-bridge.md) | In-memory queue, cancellation, process supervision, acknowledged Python/Node protocol |
| [05-discovery-and-publication.md](05-discovery-and-publication.md) | Existing discovery engine integration, capability proposal, draft validation and atomic publication |
| [06-artifact-and-deterministic-replay.md](06-artifact-and-deterministic-replay.md) | Artifact contract, fresh semantic/visual targeting, result semantics and validation replay |
| [07-api-contracts.md](07-api-contracts.md) | Concrete request/response DTOs, endpoint owners, status/error/action semantics |
| [08-cuts-and-future-architecture.md](08-cuts-and-future-architecture.md) | Deferred handoff/guardrails and report-only remote/scale design |
| [09-lovable-integration.md](09-lovable-integration.md) | Actual frontend owners, endpoint mapping, staged replacement of mocks |
| [10-validation-and-submission.md](10-validation-and-submission.md) | Necessary checks, genuine end-to-end evidence, submission artifacts and cut lines |
| [11-combined-execution-order.md](11-combined-execution-order.md) | One dependency-ordered BACKEND + FRONTEND rollout checklist |
| [12-planning-review.md](12-planning-review.md) | Coverage, documentation verification and unchanged-file checks |
| [lovable-prompts/README.md](lovable-prompts/README.md) | Future prompts, their prerequisites and sending rules; none sent now |

Read 00, 01, 06 and 07 before implementation; follow 11 for work order. Each implementation plan includes file ownership, typed seams, task checkboxes and acceptance gates. Shared contracts live in 01/06/07 rather than being redefined in every plan.

## Locked decisions

- FastAPI + SQLite; DB file under this repository; Railway backend target. Git is not runtime persistence. One process, one in-memory queue/worker, persisted runs/events; no Redis/Celery/durable broker or automatic process-death session recovery.
- Keep Node/TypeScript, Playwright/Chromium, OpenRouter and typed dispatch as the execution engine. Python owns control/storage/capability lifecycle; it does not duplicate discovery or decide semantic equivalence.
- Exactly eight logical tables: `runs`, `artifacts`, `artifact_assets`, `run_events`, `evidence_assets`, `capabilities`, `app_deployments`, `capability_bindings`. No tenant/product registries, compatibility-check or handoff tables.
- Use `app_deployments` / `app_deployment_id` everywhere in new contracts. One tenant can have multiple product deployments. Deployment upgrades update configuration, not identity. Artifacts, UI releases and schema/tool format versions are distinct.
- Capability identity and shared typed input/output contracts are stable. On successful discovery the LLM explicitly selects reuse or proposes a new operation; Python validates and assigns UUIDs/timestamps. Names never imply equivalence. Reuse never silently changes the shared contract.
- First validated discovery publishes a capability if needed, artifact and INITIAL READY binding in one SQLite transaction. Later publication never silently changes an existing active binding. Every replay pins an exact artifact and captures binding/deployment configuration selection.
- MinIO stores permitted screenshots and reference crops; SQLite stores object keys/metadata. Never persist signed URLs as identifiers. Preserve existing runtime redaction/screenshot permissions and inline image bytes in model history.
- Artifact plans have stable step IDs and durable targets, not historical observation IDs/control refs/call IDs (including `source_tool_call_id`). Live tool inputs and runtime identifiers belong in events only.
- Point replay targets use cropped visual reference images + relative crop points + unique deterministic matches on fresh screenshots. No recorded-coordinate replay, even with guards. Pre-dispatch crop boundaries must be supplied explicitly; a clicked x/y alone is insufficient.
- Events use `(run_id, sequence, timestamp, type, nullable step_id, payload)`. Discovery step IDs are NULL. `tool_finished` is an event type. Evidence joins by `run_id + event_sequence`, never ID arrays in event payloads.
- Natural-language tasks remain normal. No human capability-ID requirement. Typed pinned replay is a separate artifact action. Frontend routes remain unprotected; no auth workstream.
- Preserve the existing Lovable layout, progressive disclosure, typography, mobile behavior and sidebar Light/System/Dark icons.
- Cross-deployment candidate provisioning/onboarding/bulk binding, human intervention/handoff implementation (requests, human ownership transitions, pause/takeover/return/resume, human action recording and endpoints), new discovery/replay policy guardrails, infrastructure creation, remote viewer/VNC/containers/input gateway are excluded. Existing runtime protections remain intact.

## New recommended implementation choices (reviewable, not previously locked)

1. Python 3.12, stdlib `sqlite3`, numbered transactional SQL files with `PRAGMA user_version`; avoid ORM/Alembic for eight small tables. Pydantic DTOs + JSON Schema validation. Resolve library pins at execution and record a lockfile, without upgrading existing Node packages incidentally.
2. Repository-root `data/interface-ai.sqlite3`, WAL, synchronous FULL, one Uvicorn process and one service replica; startup migration after persistent volume is mounted. Recommended queue capacity 16 pending jobs and graceful shutdown deadline 15 seconds.
3. An acknowledged JSONL subprocess protocol v1, one supervised Node child per active job. Node cannot perform the next action before event persistence is acknowledged. Image bytes pass through a private per-run staging directory, not stdout/base64 lines or MinIO URL references.
4. Draft artifacts in the `artifacts` table; capability/version nullable only before publication. Freeze/hash the definition before validation. Run `kind=replay, purpose=validation` links to the draft; publication checks the exact validated hash and deployment configuration.
5. JSON Schema 2020-12 subset for flat, closed typed objects (string/number/boolean/scalar enum), primitive defaults; small typed DSL for checks/bindings, no arbitrary code/expression evaluation.
6. Visual matcher `rgb-template-v1`: exact image dimensions/device scale, RGB mean absolute difference, score >=0.95, overlap suppression and exactly one surviving thresholded candidate; no scaling/OCR/LLM/fallback coordinate path. Threshold needs fixture calibration before claiming production robustness.
7. Current phase maps existing runtime stops to structured run failure; it creates no intervention subsystem or human ownership state. No handoff implementation tasks or endpoints are included. Plan 08 describes report-only continuity because the assignment requires real handoff; this pass explicitly defers that requirement. Hosted headless runs expose that limitation honestly.
8. Deployment create/update and same-deployment deliberate activation are small supporting actions. Activation is limited to artifacts validated on that deployment/configuration; no cross-deployment catalog provisioning endpoint. Optional broader admin mutations stay excluded.

## Verified source baseline

No applicable root/ancestor AGENTS.md was found. This workspace currently is **not a Git repository**; do not claim a docs commit or assume a remote. Preserve existing files; plans create only this directory.

Current local owners inspected: `src/runtime/run-task.ts` (one task-local LLM loop; closes adapter in finally), `src/runtime/finalization.ts` (goal success rejected as ARTIFACT_INTEGRATION_REQUIRED), `src/runtime/dispatch.ts` (typed dispatch, current-ref/policy validation, halted/busy flags), `src/runtime/intervention.ts` (halt only), `src/adapters/surface.ts`, `src/adapters/browser/{capture,targets,browser-adapter}.ts`, `src/runtime/{history,audit}.ts`, `src/contracts/{run,observation,tools,finish-task.draft}.ts`, `src/llm/openrouter-client.ts` (120000 ms provider request timeout), `src/demo/run-task-cli.ts`, package/scripts and tests. Audit sink is synchronous; diagnostic onEvent is lossy and cannot be the persistence channel. Current semantic capture has no general scope ancestry or exported pre-action crop rectangle.

The previous GLM run under `artifacts/meridian/2026-10-05T21-23-19-536Z-glm-5.3-flash` is historical live discovery context, formally `awaiting_artifact_design`; it does not demonstrate saved artifacts/replay/handoff. Old `docs/examples/capability-lifecycle/member-lookup/*` are illustrative and non-normative, including rejected transient provenance links. Do not seed the new service from those examples.

Lovable read-only source inspection, pinned to commit `93cb7664b8b135482ef8392d90a899efe023add7`, confirmed project **AI Agent Console**, ID `6f60c709-4fda-4f4e-8a77-4430b0d24c22`, workspace `workspace_01km5gk4jhe1kawz9qk0cd76xf`, unpublished. Read domain types/store, UX-CONTRACT.md/AGENTS.md, root, task workspace, run detail, apps index/detail, artifact detail, capabilities, evidence, handoffs, ReplayDrawer, HandoffControl and diagnosis owners. No source was changed. [Editor](https://lovable.dev/projects/6f60c709-4fda-4f4e-8a77-4430b0d24c22) · [Preview](https://id-preview--6f60c709-4fda-4f4e-8a77-4430b0d24c22.lovable.app). Legacy Meridian project is outside this pack.

Remote AGENTS.md rules about mock-only store/proposal actions reflect the prior UI phase. The new user-authorized integration supersedes those scope statements; preserve canonical presentation owners and update remote architecture documentation during future integration. No reason to retain mock reducers as authorities.

## Assignment coverage and honest limits

The assignment PDF at `/Users/rahul/Downloads/Assignment A — Computer-Use Automation System.pdf` was read for requirements. Sections 3.1–3.5 map to 04–06/10; 3.6 is deferred and discussed report-only in 08; 3.7 maps to report-only design in 08/10. Current-phase completion is not full assignment completion because real same-session handoff and new guardrails are deferred. New safety expansion is deferred by scope; record existing protections and limits under Safety. `/evidence` frontend route does not satisfy repository `/evidence/` deliverable. Public repo and email submission are later human-authorized actions, never authorized by reading the PDF.

## External implementation references

Checked 2026-10-07: [Railway volume placement/runtime availability](https://docs.railway.com/volumes), [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [FastAPI CORS](https://fastapi.tiangolo.com/tutorial/cors/), [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite backup API](https://www.sqlite.org/backup.html), [MinIO Python API](https://github.com/minio/minio-py/blob/master/docs/API.md). These support the mechanics in plans; proposed protocol/matcher/state choices are this pack's recommendations, not claims from vendor docs.
