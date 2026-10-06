# FastAPI service and configuration implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. This document does not authorize provisioning or deployment.

**Goal:** A small control/storage API alongside the existing Node execution engine.
**Architecture:** One FastAPI process owns SQLite, MinIO access and one worker; a supervised Node subprocess runs one browser task at a time. Lovable connects by HTTP to this API.
**Tech stack:** Python 3.12, FastAPI/Pydantic, Uvicorn, sqlite3, MinIO SDK; existing Node 22-compatible TypeScript/Playwright stack.
**Spec:** [00](00-context-and-index.md), [01](01-schema-and-migrations.md), [07](07-api-contracts.md).

## Global constraints

No auth/protected routes, Supabase, PostgreSQL, broker, infrastructure creation or human-control subsystem. Preserve Node engine/package versions except necessary execution dependencies. Backend secrets never enter VITE variables or browser responses. One worker/service process only.

## Review focus

No ephemeral hosted DB fallback; a missing MinIO bucket is a configuration failure rather than silent creation. Importing application modules must not launch browsers/workers. A 120-second model request must not hold an HTTP request open. Hosted Chromium is not a visible local session. Config/health errors must not disclose keys.

## File ownership and dependencies

Create `backend/pyproject.toml` and one Python dependency lock, `backend/interface_api/__init__.py`, `main.py` (app factory/lifespan), `config.py` (settings/path validation), `dto.py` (07 HTTP DTOs), `errors.py` (error envelope), `api.py` (small routers), `services.py` (run/deployment service), `lifecycle.py` (05), `db.py`/`repositories.py` (01), `storage.py`/`evidence.py` (03), `worker.py`/`bridge.py` (04), `maintenance.py` (01 backup + 03 cleanup), `export.py` (10). Do not split into packages per endpoint before necessary.

Python dependencies: fastapi, uvicorn, pydantic-settings, minio, jsonschema; tests pytest + httpx. stdlib sqlite3 and asyncio; no ORM/task framework. Resolve compatible versions at implementation and pin them; this planning pass installs nothing. Node bridge uses existing tsx initially: Python launches `node <repo>/node_modules/tsx/dist/cli.mjs <repo>/src/bridge/runner-cli.ts`, resolved from config to real absolute paths; no shell invocation. A future build can replace tsx with compiled JS without changing the protocol.

## Configuration contract

| Variable | Required/default | Meaning |
|---|---|---|
| `INTERFACE_DB_PATH` | `data/interface-ai.sqlite3` | Repo-relative DB path; rejected if it escapes root |
| `INTERFACE_ENV` | `local`; explicit `railway` for hosted | Deployment configuration mode; not a feature flag |
| `INTERFACE_CORS_ORIGINS` | JSON list, explicit | Exact origin(s), e.g. `http://localhost:3000`, `https://id-preview--6f60c709-4fda-4f4e-8a77-4430b0d24c22.lovable.app`; add editor iframe origin only if observed |
| `MINIO_ENDPOINT` | required `host:port`, no scheme | Server-side upload/read endpoint |
| `MINIO_SECURE` | `true` | TLS for SDK transport |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | required secret values | Backend SDK credentials; not stored in DB/events |
| `MINIO_BUCKET` | required existing private bucket | User-provisioned bucket; app verifies access, creates no bucket/policy |
| `MINIO_PUBLIC_ENDPOINT` | required for browser assets | Browser-reachable S3 endpoint `host:port` used by signing client |
| `MINIO_PUBLIC_SECURE` | `true` | HTTPS required for hosted browser clients |
| `MINIO_REGION` | explicit or SDK-discovered then cached | Needed to sign with external endpoint; same bucket/credentials |
| `INTERFACE_NODE_BIN` | resolved Node executable | Node >=22<23 or >=24 as existing package engines require |
| `INTERFACE_BROWSER_HEADLESS` | local `false`, hosted `true` | Same-machine demo visible; hosted headless. No remote viewer implied |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | required to accept discovery | Read only by backend/Node environment; configured model slug stays private as current runtime does |
| `INTERFACE_MAX_TOOL_CALLS` | existing runtime default | Validate with existing maxToolCalls helper, not client override |
| `PORT` | local `8000`; Railway injected | Uvicorn bind port |

Keep queue capacity 16, shutdown grace 15 seconds, protocol ready 10 seconds/ACK 30 seconds and signed URL lifetime 300 seconds as code constants initially; avoid a scheduler/settings framework. Existing browser operation deadlines and 120000 ms OpenRouter timeout remain as they are. Add AbortSignal support without replacing the existing timeout.

Use `.env.example` placeholder-only entries and README setup; ignore real `.env`. Environment supplies trusted runtime policy configuration through existing RuntimePolicy construction; the public API accepts no allowlist/policy/secret fields. Do not add policy guardrail work here. A missing model disables discovery readiness while replay/read endpoints can remain available; `/health/ready` reports components and operation availability honestly. An unavailable storage/DB/worker means ready=false.

## Task 1: Bootstrap and lifespan

**Files:** Above configuration/main/errors files; `backend/tests/test_service.py`.
**Interfaces:** `load_settings(env: Mapping[str,str], repo_root: Path) -> Settings`; `create_app(settings: Settings) -> FastAPI`; `lifespan(app) -> AsyncIterator[None]`.

- [ ] Tests: importing main has no side effects; `create_app` with temporary settings starts once; secret values never appear in health/errors; invalid escaping DB path/missing hosted mount fail startup.
- [ ] Run `python -m pytest backend/tests/test_service.py -q`, implement, require PASS.
- [ ] Lifespan order: resolve/check paths -> migrate -> verify MinIO access -> mark prior lost work interrupted -> start one worker -> accept requests. Shutdown: disable starts -> drain/cancel as 04 -> stop child/process group -> flush metadata -> close resources. Use [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/); no worker created per request or reload import.
- [ ] Health: GET `/health/live` returns `{status:"alive"}`. GET `/health/ready` 200 or 503 with `{ready,db,storage,worker,discovery_available,replay_available,execution_location:"local"|"railway",handoff:"deferred"}`; no endpoint/secret/model dumps. Before 05/06 implementation, operation availability is false, not synthetic success.
- [ ] Gate: one worker start across tests; start requests return 202 promptly and never await model completion.

## Task 2: CORS and hosting path

**Files:** `main.py`, `config.py`, `.env.example`, `README.md` future setup section; `backend/tests/test_cors.py`.

- [ ] Configure explicit origins, `allow_credentials=False`, methods GET/POST/PATCH/OPTIONS, headers Content-Type/Idempotency-Key. Do not treat CORS as authentication or tenant security. [FastAPI CORS](https://fastapi.tiangolo.com/tutorial/cors/) describes origin handling. No wildcard-origin workaround for preview problems.
- [ ] Test allowed preview-origin preflight for POST with Idempotency-Key passes; unrelated origin has no Allow-Origin; requests without Origin remain valid. Asset `<img>` GET uses signed URLs, not backend credentials; MinIO/browser CORS needs configuration only if fetching/canvas operations require it.
- [ ] Local future command after install: `cd backend`, `python -m uvicorn interface_api.main:app --host 127.0.0.1 --port 8000 --workers 1`. `main:app` lazily loads settings through factory/lifespan; tests inject settings. Do not run with autoreload while collecting persistent run evidence.
- [ ] Railway packaging plan: copy repository to `/app`, install pinned Python dependencies, `npm ci`, Playwright Chromium/system libraries, then start Uvicorn on `0.0.0.0:$PORT --workers 1`. Image/start command is future packaging work, not infrastructure provisioning. One replica, no worker autoscaling/parallel DB writers.
- [ ] Gate: explain required user-provisioned `/app/data` volume + existing MinIO in setup. Startup verifies volume, bucket, writable data path; no live infrastructure changes now.

## Execution location seam

Current-phase executable arrangements:

1. **Local demonstration:** FastAPI + its Node child on the same development machine, Node launches visible Chromium. Run Lovable exported app locally against `http://127.0.0.1:8000`. This is the reliable local integration path. HTTPS remote preview -> local HTTP API can hit mixed-content/private-network restrictions; don't claim it works without browser proof or silently add a tunnel/remote-runner service.
2. **Hosted integration:** Railway FastAPI + Node child + headless Chromium in the same service, persisted DB volume and MinIO. Lovable preview uses the eventual HTTPS API base. No accessible local Chromium window, no handoff. Model/MinIO credentials live on Railway server.

These are separate runtime stores/configuration; do not imply hosted API dispatches to the local machine. A split hosted-control/local-execution connector is report-only, not a second runner registration/lease protocol in this phase. Assignment real handoff is deferred regardless of visible local browser; visibility alone does not implement control transfer.
