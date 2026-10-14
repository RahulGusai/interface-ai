# Interface AI

Give the agent a goal, let it discover the flow in a browser, then save and replay that flow with new inputs. Discovery uses an OpenRouter model. Replay executes the saved artifact without model calls.

The [agent console](https://synth-console.lovable.app) and [Meridian target application](https://legacy-account-servicing.lovable.app) are deployed. Meridian is a synthetic banking application with search, customer profiles and account workflows. This repository contains the runtime, FastAPI backend, contracts and tests; the two Lovable applications are hosted separately.

Start with the [recorded demonstration and evidence](evidence/README.md), the [design report](REPORT.md), or the [entity and schema diagrams](docs/report-schema-reference.md). The demonstration includes genuine discovery, validation, a changed-input replay and a missing-target replay that stops after human review.

## Setup

Use Python 3.12 or 3.13, Node 22 or 24+, `uv`, and Chromium. Node 23 is unsupported. The command examples also use `curl` and `jq`. Run these commands from the repository root:

```sh
npm ci
npx playwright install chromium
uv sync --project backend
cp .env.example .env
```

On Linux, install Chromium's system dependencies with `npx playwright install --with-deps chromium` if needed. Fill in the ignored `.env` file:

| Setting | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Server-side model access for genuine discovery. Choose a model that supports images and tool calls. Replay does not call the model. |
| `MINIO_ENDPOINT` | Internal S3 endpoint as `host:port`, without a URL scheme. |
| `MINIO_PUBLIC_ENDPOINT` | S3 endpoint reachable by the browser for signed image downloads. This is the S3 endpoint, not the MinIO console. |
| `MINIO_SECURE`, `MINIO_PUBLIC_SECURE` | Whether the respective endpoints use TLS. Defaults are `true`. |
| `MINIO_BUCKET`, `MINIO_REGION` | Existing private bucket and region. The default region is `us-east-1`. |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Server-only credentials for that bucket. |
| `INTERFACE_CORS_ORIGINS` | JSON array of exact console origins, such as `["http://localhost:8080"]`. CORS provides no authentication. |
| `INTERFACE_BROWSER_HEADLESS` | `false` opens a visible local browser; set `true` for a headless machine. Railway forces headless mode. |
| `INTERFACE_NODE_BIN` | Optional absolute path to a supported Node executable. |

Keep the other defaults in `.env.example` for local use. The database defaults to `data/interface-ai.sqlite3`; the default tool-call limit is 40 and the review timeout is 300 seconds. The service verifies the existing bucket and its privacy policy; it does not create one. Missing settings never enable a fake discovery runner or a local storage fallback.

Start one API worker:

```sh
PYTHONPATH=backend backend/.venv/bin/uvicorn interface_api.main:app \
  --host 127.0.0.1 --port 8000 --workers 1
```

In another terminal:

```sh
curl -fsS http://127.0.0.1:8000/health/ready | jq
```

Readiness reports discovery and replay availability separately. Catalog endpoints remain usable when live dependencies are missing. Interactive API documentation is at `http://127.0.0.1:8000/docs`; the checked-in contract is [contracts/openapi.json](contracts/openapi.json).

## Run without live services

After installing dependencies and Chromium, the scripted demo uses a fake model and a real local browser. It needs no OpenRouter, API server or MinIO:

```sh
npm run demo:computer-use
```

It starts its own synthetic fixture and prints tool results. This checks browser mechanics; the genuine recorded discovery is in [evidence/member-lookup](evidence/member-lookup/README.md).

The automated checks also use local fixtures and test doubles by default:

```sh
npm run typecheck
npm test
PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests -q
```

Browser and integration tests need permission to launch Chromium and bind localhost. The live-provider test is opt-in. A separate minimal fixture can be served with `python3 -m http.server 4173 --bind 127.0.0.1 --directory tests/fixtures/replay-member-desk`; its member-email workflow differs from the hosted Meridian customer-name workflow below.

## Demo: goal to artifact to replay

The following commands use the local API configured above and the hosted synthetic Meridian target. For the already-configured hosted backend, set `API=https://interface-ai-api-production.up.railway.app` instead. Use one Bash or Zsh shell for the sequence. These commands create new runs; viewing the saved [evidence](evidence/README.md) requires no services or keys.

### 1. Register the target and start discovery

```sh
set -euo pipefail
API=http://127.0.0.1:8000
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

DEPLOYMENT_ID=$(curl -fsS "$API/v1/app-deployments" \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"submission-demo","product_id":"meridian-testbed","base_url":"https://legacy-account-servicing.lovable.app","environment":"demo","ui_variant":"classic","vendor_release":"1.0"}' \
  | jq -er '.app_deployment_id')

DISCOVERY_KEY=$(uuid)
DISCOVERY_ID=$(jq -n --arg deployment "$DEPLOYMENT_ID" '{
  kind: "discovery",
  app_deployment_id: $deployment,
  access_policy: "READ_ONLY",
  task: "Find Halima Achterberg, making sure you select the correct customer if multiple people share that name. Open their profile and report their customer ID and contact details without changing any records.",
  inputs: {customer_name: "Halima Achterberg"}
}' | curl -fsS "$API/v1/runs" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $DISCOVERY_KEY" --data-binary @- \
  | jq -er '.run_id')

wait_run() {
  local run_json run_status
  while :; do
    run_json=$(curl -fsS "$API/v1/runs/$1") || return 1
    run_status=$(printf '%s' "$run_json" | jq -r '.status')
    case "$run_status" in
      completed) printf '%s\n' "$run_json"; return 0 ;;
      failed|cancelled|interrupted|awaiting_human)
        printf '%s\n' "$run_json" | jq >&2
        return 1 ;;
    esac
    sleep 3
  done
}

DISCOVERY=$(wait_run "$DISCOVERY_ID")
printf '%s\n' "$DISCOVERY" | jq '{run_id,status,inputs,outcome}'
ARTIFACT_ID=$(printf '%s' "$DISCOVERY" | jq -er '.finalized_artifact_id')
curl -fsS "$API/v1/artifacts/$ARTIFACT_ID" | jq '{state,definition}'
```

The model generates capability metadata, observes the UI and proposes actions. The runtime records successful actions, requires explicit input bindings for variable values, and creates a frozen draft when the task completes. The supplied `inputs` are checked against the generated contract. The sample should expose `customer_name`; inspect the returned schema before replaying a newly discovered artifact because model-generated field names can vary.

If the poll stops at `awaiting_human`, inspect the pending review in the console for the hosted backend, or through `/v1/human-reviews?run_id=<run UUID>` on a local backend. Decide the review before polling that same run again. Every start or validation requires a UUID `Idempotency-Key`. After a timeout, reuse the same key and body, or read `/v1/runs/by-request/{key}`; a new key admits another run.

### 2. Validate and publish the draft

```sh
VALIDATION_KEY=$(uuid)
VALIDATION_ID=$(jq -n --arg deployment "$DEPLOYMENT_ID" '{
  app_deployment_id: $deployment,
  access_policy: "READ_ONLY",
  inputs: {customer_name: "Halima Achterberg"}
}' | curl -fsS "$API/v1/artifacts/$ARTIFACT_ID/validate" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $VALIDATION_KEY" --data-binary @- \
  | jq -er '.run_id')

wait_run "$VALIDATION_ID" | jq '{run_id,status,outcome}'
curl -fsS "$API/v1/artifacts/$ARTIFACT_ID" \
  | jq '{artifact_id,state,version,definition_sha256,publication}'
```

Successful validation replays the draft without a model, publishes an immutable version and creates the capability's initial ready deployment binding. Expect Halima's customer ID `C483704` and contact details for the fixture used in the recording.

### 3. Replay with a different customer

```sh
REPLAY_KEY=$(uuid)
REPLAY_ID=$(jq -n --arg deployment "$DEPLOYMENT_ID" --arg artifact "$ARTIFACT_ID" '{
  kind: "replay",
  app_deployment_id: $deployment,
  artifact_id: $artifact,
  access_policy: "READ_ONLY",
  inputs: {customer_name: "Tomas Achterberg"}
}' | curl -fsS "$API/v1/runs" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $REPLAY_KEY" --data-binary @- \
  | jq -er '.run_id')

wait_run "$REPLAY_ID" | jq '{run_id,status,outcome}'
curl -fsS "$API/v1/runs/$REPLAY_ID/events?after_sequence=0&limit=200" | jq
```

The recorded example returns `GOAL_ACHIEVED`, customer ID `C135291`, and `tomas.achterberg59@example.test`. The replay selects the row using the new input and extracts fresh values. Fixture resets or application changes may change results. For complete event retrieval, follow `next_after_sequence` until `has_more=false`, including when a filtered page is empty.

### 4. Exercise the exceptional path

Repeat the replay request with a new request key and `customer_name: "Demo Missing Customer 999999"`. In the recorded artifact, step 5 cannot resolve the customer's Open link. The run pauses for target selection. Open Handoffs in the hosted console, inspect the screenshot and candidates, and reject because no candidate opens the requested customer. A local operator can inspect `/v1/human-reviews?run_id=<run UUID>` and POST `{"decision":"rejected","comment":"No matching customer; stop this action."}` to `/v1/human-reviews/{review_id}/decision`.

The expected terminal result is `hard_failure`, code `HUMAN_REVIEW_REJECTED`, with `dispatch_state: "not_dispatched"` at step 5. This demonstrates missing-target escalation and rejection. The generated artifact has no declared business outcomes, so it does not return a typed `MEMBER_NOT_FOUND` result. The [exception evidence](evidence/member-lookup/README.md#exceptional-replay) preserves the full sequence.

## Runtime and lifecycle

FastAPI owns admission, SQLite records, private MinIO evidence and publication. A supervised Node/Playwright child owns discovery or replay. Replay pins the artifact ID, version, definition hash and deployment configuration at admission. `/v1/capabilities/{id}/invoke` selects the current ready binding; `/v1/runs` can select an explicit published artifact.

One process owns one active browser and an in-memory queue of 16 pending jobs. A paused review holds that execution slot. The Node session stays alive while a durable review awaits a decision; approval or target selection requires fresh screen and target checks before continuation. Review decisions are recorded and never reused as approval for a later replay. See [human review](docs/human-review.md) and the [report](REPORT.md#escalation--handoff).

Deployment updates use `expected_config_version`. Later artifact versions leave an existing binding unchanged until explicit activation through `/v1/app-deployments/{id}/bindings/{capability_id}/activate`, with artifact/validation UUIDs and `expected_binding_version`. Validation and activation currently support the source deployment only.

POST `/v1/runs/{id}/cancel` with `{}` to cancel. Already-dispatched actions may settle or remain uncertain; they are not retried to repair evidence. Restart marks unfinished runs interrupted and does not requeue them. Events and screenshots join on run ID and event sequence. Artifact crops are separate assets. Image content endpoints issue fresh 300-second signed URLs with `Cache-Control: no-store`.

## Policy and current limits

`READ_ONLY` is the default, but currently bypasses action classification, assessment-based approval and domain-policy enforcement. It records task intent and does not guarantee that writes are blocked. Both modes retain tool schemas, target/reference validation, execution limits and success checks. The included demo performs a read-only customer lookup on synthetic data.

`READ_WRITE` pauses on explicit review requests, missing or invalid assessments, and `auto_approve` confidence below 0.3. It checks the exact deployment hostname for document navigation, including redirects and frames; external assets may load. Service workers are disabled and unclassified native dialogs stop the run. Approval cannot override domain, freshness or browser-blocker checks. Replay uses the saved assessment but requests fresh human approval when required; changed inputs can make an old assessment unsuitable.

The operator console supports approval, rejection and target selection in the retained browser session. It displays captured screenshots, not a continuous live stream. Direct mouse/keyboard takeover and an embedded live session are the next extension. The recording demonstrates rejection; it does not demonstrate a successful manual takeover and return to the agent.

This prototype lacks API/operator authentication, tenant authorization and general redaction of page text, screenshots or extracted values. Use synthetic data. Generated output fields currently accept arbitrary JSON, and generated plans need richer business checks and exception declarations. The [report](REPORT.md) explains these limits and the next steps. Older planning and verification notes under `docs/` describe their dated implementation stages; this README and the submission evidence describe the recorded version.

## Evidence and export

[evidence/README.md](evidence/README.md) indexes the reviewed recording, saved artifact, all four event logs, run records, handoff decision and 53 screenshots. It also documents integrity checks and how the hosted data was collected. No model or storage credentials are included.

For new runs stored in your own configured backend, the existing exporter reads its SQLite database and private object storage:

```sh
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.export \
  --synthetic \
  --source-run "$DISCOVERY_ID" \
  --replay-run "$REPLAY_ID" \
  --output evidence/new-member-lookup
```

Add another `--replay-run` for an exceptional run. The source must have a published artifact, and the destination must be new. Run the exporter against the backend that owns those records; a local database cannot export hosted run IDs. The checked-in package was collected through the deployed API instead, as recorded in [provenance.json](evidence/member-lookup/provenance.json). Downloads are verified against asset hashes. Review synthetic content before sharing.

## Persistence and hosting

SQLite uses WAL, foreign keys, full synchronous commits, versioned migrations and a process ownership lock. For Railway, mount a persistent volume at `/app/data`, set `RAILWAY_VOLUME_MOUNT_PATH=/app/data` and `INTERFACE_ENV=railway`, and use one replica/worker. Keep the database volume across releases; startup owns schema migration. Server credentials stay out of the browser and the Node start envelope.

```sh
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance backup /safe/location/backup.sqlite3
# Stop the API before restore; its ownership lock prevents concurrent restore.
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance restore /safe/location/backup.sqlite3
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance cleanup-assets --dry-run
# Apply only after reviewing the dry run.
PYTHONPATH=backend backend/.venv/bin/python -m interface_api.maintenance cleanup-assets --apply
```

Backup uses SQLite's consistent online backup API. Restore validates the file and preserves a prior snapshot. Cleanup removes unreferenced application objects older than 24 hours, excluding live runs and drafts. No cleanup scheduler is installed.
