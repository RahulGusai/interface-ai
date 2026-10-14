# Approval review backend

This implements the agreed take-home flow. Both Lovable apps are deferred. Node owns the live browser and loop; Python owns durable state. There is no browser stream, manual input transport, message broker or crash resume.

## Routing

Each READ_WRITE LLM tool call carries `execution: {decision, confidence, reason}`. The system prompt describes assessment of the proposed effect, current UI, target (including points), arguments and policy. Tool schemas require it; the runtime handles missing/invalid metadata conservatively.

| Effective policy / assessment | Behavior |
|---|---|
| READ_ONLY | Bypass action/domain policy, trusted rules and assessments; no approval flow |
| READ_WRITE + `requires_human_review` | Review at any confidence |
| READ_WRITE + `auto_approve`, confidence < 0.3 | Review |
| READ_WRITE + `auto_approve`, confidence >= 0.3 | Execute after hard checks |
| READ_WRITE + missing/invalid assessment | Review |
| READ_WRITE hard domain violation or browser/target blocker | Stop; approval cannot override |

READ_ONLY provider prompts and tool schemas omit execution assessments; supplied assessments are ignored and discovery records no assessment. Its browser skips action/domain interception and uses normal dialog mechanics. Stale references, target validity, tool limits and completion checks still apply.

READ_WRITE runtime-owned entry navigation uses an explicit auto assessment. `request_human` in READ_WRITE always reviews and returns an approved tool result before the agent continues; it supplies no manual target choice or typed user instructions. In READ_ONLY its previous terminal behavior remains.

## Persistence and HTTP

Migration 0004 adds `awaiting_human` to runs and the `human_review` table. A review contains `review_id`, `run_id`, `call_id`, tool, exact resolved arguments, assessment decision/confidence/reason, effective policy, screenshot asset ID, source event sequence, state fingerprint, lifecycle status, deadline, timestamps and optional human comment. A partial unique index permits one pending review per run.

| Endpoint | Purpose |
|---|---|
| `POST /v1/runs/{run_id}/human-reviews` | Runtime creates a pending review from an acknowledged `human_review_snapshot` event and its screenshot |
| `GET /v1/human-reviews?status=pending&run_id=...` | Operator queue, optional filters, normal page/page_size pagination |
| `GET /v1/human-reviews/{review_id}` | Runtime polls and UI reads details |
| `POST /v1/human-reviews/{review_id}/decision` | Human sends `{"decision":"approved"}` or `{"decision":"rejected","comment":"Reason"}` |
| `GET /v1/evidence-assets/{screenshot_asset_id}/content-url` | Existing signed screenshot URL endpoint |

Poll **`status`**, not `assessment_decision`. Status is `pending`, `approved`, `rejected`, `expired` or `cancelled`; the latter four are terminal for that review. Creation reuses the same UUID and exact body across HTTP retries. A duplicate identical decision is idempotent; conflicting or late decisions return 409. Creation verifies the action and screenshot match persisted evidence. No image bytes are stored in the review row. The current prototype API has no operator authentication; CORS is not authorization.

## Waiting and resumption

1. Persist the snapshot and screenshot through the existing acknowledged event pipe.
2. Create review through HTTP, atomically moving `running -> awaiting_human`.
3. Await polling every second. The JavaScript event loop and API remain responsive. The execution worker slot stays occupied, so subsequent jobs remain queued.
4. Approval atomically records the decision and moves the run back to `running`. Node observes it, compares a fresh UI/DOM/layout fingerprint and revalidates the pending target, then dispatches that exact action once. Changed context creates a new review; an invalid/stale target stops. The same browser/history continues with subsequent tools and normal success checks.
5. Rejection/expiry stops before dispatch and records the specific failure. Cancellation aborts polling and closes the browser through existing cleanup. Startup marks unfinished runs interrupted and cancels pending reviews. An approval alone does not mean the action executed; use subsequent tool events and the run outcome for that fact.

The screen check is conservative: animation or changing text can require another review. It is not a guarantee against a hostile page changing behavior between checking and acting. The runtime never retries a possibly dispatched action. Poll transport failures retry within the deadline; protocol errors fail closed. Snapshot persistence precedes a separately bounded creation request. Once created, the client uses the server’s persisted expiry plus up to five seconds for a final status read, so it can recognize approval committed before expiry. Unconfirmed creation ends with `HUMAN_REVIEW_API_TIMEOUT`.

`INTERFACE_REVIEW_TIMEOUT_SECONDS` defaults to 300, range 1–3600. `INTERFACE_RUNTIME_API_URL` defaults to `http://127.0.0.1:${PORT:-8000}`; override it if the API listens elsewhere. Node and FastAPI must reach the same API/database. This remains a one-process/one-worker deployment.

## Replay

READ_WRITE artifact steps save their discovery execution assessment. Replay resolves fresh inputs and targets without an LLM call. READ_WRITE reuses stored assessments; READ_ONLY ignores assessments and bypasses policy/review routing. A review-required step creates a new review for each run (including validation), with its current screenshot and arguments. Approvals are never stored as artifact permission. Legacy steps lacking assessments require review in READ_WRITE.

Stored assessment is not a fresh semantic risk evaluation: changed inputs, context or application behavior can make it stale. This limitation, self-reported model confidence, and the future need for re-assessment or deterministic rules are recorded in REPORT.md.

## Verification

Tests use local synthetic applications. Coverage includes the 0.3 boundary, missing/invalid assessments, point/control targets, context changes, real HTTP polling with the Node subprocess and Chromium, PNG persistence, approve-and-complete, rejection/expiry/cancel without writes, and the occupied sequential execution slot. Storage SDK calls are substituted in the end-to-end tests; they do not constitute hosted MinIO, live model or deployment verification.

Verified on 2026-10-11 with Node 22.19.0 and Python 3.12: 229 Node tests passed, one opt-in live-provider test skipped; all 60 backend tests passed. TypeScript typecheck, Ruff, changed-TypeScript Prettier, generated OpenAPI/artifact-schema comparisons and `git diff --check` passed. The backend reports the existing Starlette/httpx deprecation warning. A separate reviewer identified the deadline issue; both reproductions failed before the fix, passed afterward, and the reviewer accepted the correction.

Verified the READ_ONLY bypass on 2026-10-14 with Node 22.19.0: 237 runtime tests passed and the opt-in live-provider test was skipped; all 60 backend tests passed. Typecheck, changed-TypeScript Prettier, Ruff, changed-Python formatting and `git diff --check` passed. Regression coverage includes production-factory search without rules or assessment, point writes, domain redirects, native dialogs, provider schemas, stale references, and Python/Node replay; READ_WRITE review and domain gates remain covered.

Fixed the READ_WRITE inline-frame false positive on 2026-10-14: Meridian's same-host customer overview contains an `about:srcdoc` statement frame. Inline `about:srcdoc`/`about:blank` child documents now inherit an allowed ancestor's scope; top-level networkless navigation and external frame requests/redirects remain blocked. The profile-opening and nested-inline regressions failed before the fix and passed after it. Full verification: 242 runtime tests passed, one live-provider test skipped, all 60 backend tests passed; typecheck, changed-TypeScript formatting and diff checks passed.
