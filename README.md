# Interface AI

FastAPI owns run lifecycle, SQLite records, private MinIO evidence and capability publication. A supervised Node/Playwright child performs OpenRouter discovery or deterministic artifact replay. Replay constructs fresh tool inputs and makes no model calls.

The backend plans in [execution order](docs/plans/2026-10-07-backend-frontend-integration/11-combined-execution-order.md) are implemented on `main`. See [verification](docs/backend-verification.md) for test evidence and outstanding external gates. The Lovable frontend integration is a separate planned phase.

## Local setup

Use Python 3.12 and Node 22 or 24+. Node 23 is unsupported. Install `uv`, then from the repository root:

```sh
npm ci
npx playwright install chromium
uv sync --project backend
cp .env.example .env
```

Configure the existing private MinIO bucket's internal S3 endpoint, externally reachable S3 signing endpoint, region and server-only credentials. The service verifies the bucket and its policy; it creates no bucket. Read/catalog endpoints remain usable when model/storage configuration is absent; `/health/ready` reports separate discovery and replay availability. Missing configuration never enables a fake runner or local object-store fallback.

For a permitted synthetic UI demo, set `INTERFACE_ALLOW_WRITES=true` and `INTERFACE_ALLOW_SCREENSHOTS=true` in the ignored server `.env`. These configure the existing runtime policy. Production document/resource URLs are restricted to the registered target origin and configured path prefix. Keep credentials out of task text and browser configuration.

```sh
PYTHONPATH=backend backend/.venv/bin/uvicorn interface_api.main:app --host 127.0.0.1 --port 8000 --workers 1
# In another terminal, serve the dedicated synthetic fixture:
python3 -m http.server 4173 --bind 127.0.0.1 --directory tests/fixtures/replay-member-desk
```

Local execution uses one visible browser unless headless is explicitly enabled. Set `INTERFACE_NODE_BIN` if the default `node` is unsupported. CORS accepts only exact configured frontend origins; it provides no authentication. No auth routes are added in this phase.

## Register and discover

Use `/docs` or the exported [OpenAPI contract](contracts/openapi.json). Starts and validation require a UUID `Idempotency-Key`; retry the same body with the same key after a timeout, or read `/v1/runs/by-request/{key}`. A different body with the same key returns 409.

```sh
curl -sS http://127.0.0.1:8000/v1/app-deployments -H 'Content-Type: application/json' -d '{"tenant_id":"synthetic","product_id":"desk","base_url":"http://127.0.0.1:4173","environment":"demo","ui_variant":"standard","vendor_release":null}'
```

Copy its deployment UUID into the discovery request. Generate a request key with `python3 -c 'import uuid; print(uuid.uuid4())'`.

```json
{"kind":"discovery","app_deployment_id":"<deployment UUID>","task":"Look up synthetic member demo@example.test and report the displayed status"}
```

POST it to `/v1/runs` with `Content-Type: application/json` and the key header. Poll the returned run ID and `/v1/runs/{id}/events?after_sequence=0`. Follow `next_after_sequence` until `has_more=false`, even when a type-filtered page has no items.

A narrative completion cannot publish. Successful discovery prepares a frozen draft, executes a linked replay with `purpose=validation`, and atomically publishes a capability/artifact and the pair's first ready binding. Failed validation remains inspectable. Subsequent artifact versions leave an existing binding unchanged. Point actions require explicit pre-action reference bounds; unrecorded screen coordinates cannot become an artifact.

## Replay and lifecycle

After publication, use the exact artifact UUID:

```json
{"kind":"replay","app_deployment_id":"<deployment UUID>","artifact_id":"<published artifact UUID>","inputs":{"email":"other@example.test"}}
```

POST `/v1/runs` with a new request key. The fixture should return `status=Pending`; `missing@example.test` yields the declared expected `not_found` outcome. Inputs are validated before admission. `/v1/capabilities/{id}/invoke` selects the current ready binding and freezes its artifact/version/configuration on admission.

PATCH deployment config using `expected_config_version`. Revalidate an unchanged artifact through `/v1/artifacts/{id}/validate` with `{app_deployment_id,inputs}` and a request key. Explicit activation uses `/v1/app-deployments/{id}/bindings/{capability_id}/activate` with artifact/validation UUIDs and `expected_binding_version`. Validation and activation are limited to the artifact's source deployment; other deployments are not provisioned as candidates.

POST `/v1/runs/{id}/cancel` with `{}` for ordinary cancellation. Already dispatched actions may settle or remain uncertain; they are never retried to repair evidence. Restart marks unfinished records interrupted and never requeues them. Events and evidence join by run ID + event sequence. Crop assets are separate. Content URL reads return fresh 300-second URLs with `Cache-Control: no-store`.

## Verification and evidence export

```sh
npm run typecheck
npm test
PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests -q
```

Browser/integration tests launch Chromium and temporary localhost fixtures. Scripted model and fake SDK tests verify boundaries; they do not prove paid discovery or live MinIO. Genuine discovery requires both OpenRouter settings and actual MinIO configuration.

After a verified successful **synthetic** source and selected replays, export authoritative metadata/events and privately downloaded image bytes:

```sh
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.export --synthetic --source-run <UUID> --replay-run <UUID> --replay-run <exception UUID> --output evidence/example-member-lookup
```

The destination must be new. Missing or hash-mismatched objects fail export. Inspect the synthetic package before sharing; the exporter never publishes or submits it. Raw databases and general screenshots remain ignored by Git.

## Persistence and hosting

The repo-relative DB defaults to `data/interface-ai.sqlite3`. SQLite uses WAL, foreign keys, full synchronous commits, versioned runtime migrations and a process ownership lock. One process/replica owns a memory queue with 16 pending jobs and one browser. The queue is deliberately not durable.

The service is deployed on Railway; see the [deployment record](docs/railway-deployment.md) for the public API origin, volume and verified health. For another deployment, mount a persistent Railway volume at `/app/data`, set `RAILWAY_VOLUME_MOUNT_PATH=/app/data`, and run a single replica/worker with the existing private MinIO settings. Railway forces headless execution. The API child inherits only the required runtime environment; server credentials never travel in argv or the pipe start envelope. Keep the DB volume across releases; do not run schema migration as a separate predeploy job.

```sh
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance backup /safe/location/backup.sqlite3
# Stop the API before restore; its ownership lock prevents concurrent restore.
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance restore /safe/location/backup.sqlite3
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance cleanup-assets --dry-run
# After inspecting the dry run, explicitly apply:
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance cleanup-assets --apply
```

Backup uses SQLite's consistent online backup API. Restore validates the file and preserves a prior snapshot. Object cleanup only removes unreferenced application keys older than 24 hours, excluding live runs and drafts. Startup sweeps old terminal staging directories. No scheduler is added.

See [REPORT.md](REPORT.md) for phase limitations, [runtime development](docs/runtime-orchestration-development.md) for the legacy CLI, and [Meridian local test](docs/meridian-local-test.md) for historical source-only demo evidence.
