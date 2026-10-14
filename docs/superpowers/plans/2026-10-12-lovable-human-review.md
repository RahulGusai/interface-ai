# Lovable console human review implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For the user's selected Lovable execution, follow the sequential tasks and verification requirements directly.

**Goal:** Convert the existing Handoffs mock tab in AI Agent Console into the operator surface for reviewing and approving or rejecting a pending action for a particular run.

**Architecture:** The console reads persisted reviews from the existing FastAPI API and submits an immutable decision for a specific `review_id`. Node retains the browser and agent loop, polls the persisted review status, and continues or stops. The frontend neither resumes the runtime itself nor sends browser commands.

**Tech stack:** Existing React 19, TypeScript, TanStack Router/Query, Tailwind, shared console components, Vitest and Testing Library. Preserve the current build configuration and dependencies.

**Spec:** This document and the implemented backend contract at `d0d7b4cb4b800104dc07d66fb44faa865a37b244`. Backend references: `docs/human-review.md`, `contracts/openapi.json`, `backend/interface_api/dto.py`, `backend/interface_api/reviews.py`, and `REPORT.md`.

## Scope and verified starting point

- Work only in **AI Agent Console**, project `6f60c709-4fda-4f4e-8a77-4430b0d24c22`: <https://lovable.dev/projects/6f60c709-4fda-4f4e-8a77-4430b0d24c22>.
- Source inspected at Lovable revision `41b95bcc8ebddde7f47eb187151c0caf7cc85d4a`. Recheck the current revision before implementation and preserve intervening changes.
- Reuse the existing `/handoffs` route and sidebar position. Keep the navigation label **Handoffs**, with page description **Review actions awaiting your decision**. Do not create another operator app or parallel tab.
- Today `src/routes/handoffs.tsx` mounts `DemoStoreProvider`; `HandoffControl.tsx` simulates takeover, manual action recording, and return to automation. These controls must be replaced on this route.
- The simplified operator surface will submit real backend decisions. Remove the misleading `Mock · Deferred` and zero-API claims. Label the scope **Approval only**; clearly state that the screenshot is a snapshot.
- This is a plan artifact. No Lovable implementation or publication has been performed as part of preparing it. Backend source is merged; deployed API compatibility and the final live UI still require verification.

## Global constraints

1. Use the existing `VITE_API_BASE_URL` origin and `apiFetch`. No new backend, database, Supabase integration, authentication system, broker, WebSocket, or browser streaming.
2. Do not change the target application or add its Save operation in this task. That remains a separate Lovable task.
3. No manual browser controls, takeover ownership, typed instructions to the agent, target selection, or fabricated operator identity. Comments are audit notes, not commands.
4. Do not implement classification in the UI or call an LLM. The backend owns routing and all hard checks. The UI displays the persisted assessment.
5. Preserve existing run creation/idempotency, policy selectors, event cursor handling, artifact lineage, replay, theme, and responsive shell behavior.
6. Reuse existing design, `Disclosure`, `AssetImage`, loading/error states, and central tone mappings. Avoid an unrelated redesign or dependency changes.
7. The old project instructions that `/handoffs` must remain synthetic are intentionally superseded for this route by this task; update those instructions alongside the implementation.
8. Tests may simulate API responses. The normal application must never fall back to seeded reviews or simulated success when the API is unavailable.
9. Do not publish as part of implementation. Return the saved revision and verification results for review.

## Review focus

- A human decides one exact review, not every action in a run.
- `status` determines whether the review is concluded; `assessment_decision` is the model's recommendation.
- Approval records permission; later tool events and the run outcome establish execution and completion.
- A lost POST response must be reconciled before offering another decision.
- `awaiting_human` remains active and cancellable everywhere, including event polling and validation child runs.
- Evidence belongs to the selected review, never whichever screenshot happens to be newest.

## 1. Runtime behavior the UI must represent

| Situation | Implemented behavior | UI treatment |
|---|---|---|
| READ_ONLY | Existing deterministic policy; prohibited/unknown effects fail without review | Keep current policy failure diagnosis; do not offer approval to override it |
| READ_WRITE + `requires_human_review` | Review at any confidence | Show pending review and assessment |
| READ_WRITE + `auto_approve`, confidence below `0.3` | Review | Explain that model confidence was below the review threshold |
| READ_WRITE + `auto_approve`, confidence at least `0.3` | Proceeds after hard checks | No fabricated review row |
| Missing/invalid assessment | Conservative review | Show supplied reason; absent confidence is “Not supplied,” never zero |
| Hard domain, browser, or target violation | Stops; approval cannot override | Failure diagnosis, without a bypass button |

The run moves from `running` to `awaiting_human` when a pending review is created. The Node process and browser remain alive. With the current sequential worker, subsequent runs remain queued while it waits. Default review timeout is 300 seconds, but render the API's `expires_at`; do not hardcode the deadline.

Approval records `approved` and moves the run to `running`. Node polls the result, rechecks the screen and target, performs the approved action once, and continues the same task. A changed screen can produce a **new review ID** for the same run/call; stale targets can stop the run. Never reuse the old approval.

Rejection or expiry stops the pending action and then the run. Cancellation uses the existing run cancellation API. Earlier completed actions are not rolled back. A process restart interrupts unfinished runs and cancels pending reviews; there is no crash recovery that resumes the browser.

Replay and validation use stored step assessments, fresh targets/arguments/screenshots, and fresh reviews. No additional LLM classification is required by this frontend task. An approval in discovery never authorizes replay automatically.

## 2. Exact API contract

Import the backend OpenAPI contract into the console's `contracts/openapi.json` and regenerate `src/lib/api/types.gen.ts`; derive exported aliases from generated schemas rather than duplicating DTO types.

Pinned source: <https://raw.githubusercontent.com/RahulGusai/interface-ai/d0d7b4cb4b800104dc07d66fb44faa865a37b244/contracts/openapi.json>. If the repository cannot be fetched from Lovable, supply the same repository file as an attachment. Do not substitute an older deployed contract silently.

| Request | Use |
|---|---|
| `GET /v1/human-reviews?status=pending&page=1&page_size=20` | Pending operator queue |
| `GET /v1/human-reviews?run_id={run_id}&page=1&page_size=20` | All reviews for one run; add a status filter when selected |
| `GET /v1/human-reviews/{review_id}` | Authoritative detail and decision reconciliation |
| `POST /v1/human-reviews/{review_id}/decision` | Approve or reject that review |
| `GET /v1/evidence-assets/{screenshot_asset_id}/content-url` | Existing signed evidence URL, via `AssetImage` |
| `GET /v1/runs/{run_id}` | Current run state and task metadata |
| `POST /v1/runs/{run_id}/cancel` | Existing cancellation action; accepted asynchronously |

`POST /v1/runs/{run_id}/human-reviews` is **runtime-only**. The console must never create reviews, patch their status, or invent a resume endpoint.

List responses use `{items, total, page, page_size}`. Optional filters are `status` and `run_id`; page size is 1–100. Default order is newest first. There is no review search, bulk decision, or server ordering parameter. Do not claim an oldest-first global queue by sorting one page locally.

`HumanReviewDTO` fields:

| Field | Meaning / display |
|---|---|
| `review_id`, `run_id`, `call_id` | Review identity, owning run, exact tool-call correlation |
| `tool`, `arguments` | Proposed tool and exact resolved arguments |
| `assessment_decision` | `auto_approve`, `requires_human_review`, or null |
| `confidence` | Number 0–1, or null; display value and a percentage without rounding across the 0.3 boundary |
| `reason` | Persisted explanation for the review |
| `access_policy` | `READ_WRITE` for this feature |
| `screenshot_asset_id` | Snapshot for this action |
| `event_sequence`, `state_fingerprint` | Evidence correlation and runtime state check; technical disclosure |
| `status` | `pending`, `approved`, `rejected`, `expired`, `cancelled` |
| `run_status` | Snapshot of current owning run status |
| `created_at`, `expires_at` | Review creation and server deadline |
| `decided_at`, `human_comment` | Nullable conclusion time and recorded human note |

Decision body, response `200 HumanReviewDTO`:

```json
{"decision":"approved","comment":null}
```

or:

```json
{"decision":"rejected","comment":"This action is not appropriate for this task."}
```

Comment is optional/null and at most 2,000 characters. Choose a single normalization rule: blank/whitespace-only becomes null; otherwise preserve the entered text exactly. Normalize once before sending and freeze the resulting body for recovery. The backend considers an identical decision **and identical comment** idempotent; a different decision or comment is a conflict. There is no review `Idempotency-Key` or by-request lookup.

Handle `409 REVIEW_CONCLUDED` by reading the canonical review. Handle `422` with a visible validation error and retained draft. Handle `404` as an unavailable review, without mock substitution. Network failures, timeouts, unreadable/malformed success responses, and server errors may leave the decision outcome uncertain.

## 3. Operator page and interaction requirements

### Queue and history

- Default to pending reviews, with a pending count from the server's `total`. Provide status choices Pending / Approved / Rejected / Expired / Cancelled / All and an optional exact run ID filter. Reset pagination when filters change.
- Use 20 rows per page and real previous/next controls. If a page empties after resolution, move to the last valid page. Do not drop a selected review just because it leaves the pending list.
- Rows show run link, proposed tool/action, short reason, status, creation time, and deadline. Fetch task/deployment labels only for the selected run or reuse already cached metadata; do not fetch every run in the database.
- Keep the selected detail query independent from the list. Use `review_id` as the key everywhere; a run may accumulate several reviews over time.
- Support `/handoffs?run_id={UUID}&review_id={UUID}`. Validate search values. If both are present but the selected review belongs to another run, show an explicit mismatch and disable decisions; never silently act on the wrong run.
- No pending items is a genuine empty state. If API reads fail, show an error/retry state. Previously loaded data can remain visible with a stale warning and decisions disabled until a successful fresh detail read.

### Selected review

Show the following without requiring the operator to inspect raw JSON:

1. Run link and task summary when available; review status and current run status separately.
2. Proposed tool/action and its relevant arguments: target kind, control reference or coordinates, text/value, navigation URL, key, or other action-specific fields as applicable. Render untrusted strings as text. Do not invent a business label from an opaque target reference or execute a supplied URL.
3. Persisted reason, access policy, assessment recommendation, confidence, creation time, expiry, and optional human comment.
4. The exact review screenshot, labeled **Snapshot captured before this action**. Use `AssetImage kind="evidence" assetId={review.screenshot_asset_id}` and key it by review ID plus asset ID. Optional zoom displays the same static image.
5. Approve action and Reject action buttons, plus optional comment input with character count. Explain: **Approving lets the agent attempt this action and continue. Rejecting stops this run.** No simulated “validation passed” radio, “take control,” “record manual action,” or “return control” button.
6. Closed-by-default technical disclosure containing full IDs, raw arguments, assessment fields, event sequence, and fingerprint. Keep decision-relevant argument values visible above it; disclosure must not hide what the operator is approving.

Reuse signed URL caching, refresh-before-expiry and one re-sign-on-image-error behavior already implemented in `AssetImage`/`signedUrlQuery`. Do not persist signed URLs, embed a live app iframe, or display a synthetic thumbnail when evidence fails. Show “Image unavailable” and its retry affordance honestly. Do not claim visual verification if the image did not load.

Decisions require a successfully refreshed detail with `status=pending` and `run_status=awaiting_human`, no unresolved prior submission, and no local deadline recheck in progress. Refresh the selected review immediately before the POST; if it changed, do not send. Server checks remain authoritative for races after that GET.

Use local countdowns only as advisory display. At apparent expiry, refresh immediately and disable decisions while checking. Do not set `expired` locally or send an expiry mutation. If the server still reports pending due to clock skew, show its absolute deadline and refresh guidance rather than inventing a terminal status.

### Decision submission and recovery

Implement a small state machine: `idle -> checking -> submitting -> recorded | uncertain | error`.

1. Capture the selected `review_id`, owning `run_id`, normalized comment and decision. Disable both buttons and the comment field for this submission. Changing the selected row must not retarget an in-flight request.
2. Fresh-read the exact review, confirm eligibility, then POST the frozen body once. Configure the mutation with no automatic retries. Never reuse `submitRun` or its run-creation key logic.
3. On a valid response, verify the returned review/run IDs and expected status/comment. Otherwise treat the response as uncertain and reconcile.
4. On an uncertain response, GET that exact review. If status/comment match, show the recorded decision. If another terminal result is present, show it as canonical, including any different comment; do not attribute it to a named operator. If still pending, offer an explicit **Retry same decision** using the identical frozen body after a fresh eligibility check. Do not automatically POST again.
5. If reconciliation remains unavailable, show **Decision not yet confirmed**. Keep opposite decisions disabled for that review and provide **Check status**. Do not report success or failure based only on the transport error.
6. Retain the unresolved frozen submission across navigation/reload in a small, versioned `sessionStorage` record scoped by API origin and review ID. Store only review/run IDs, decision and comment, never screenshots, signed URLs or tokens. Guard storage for SSR and storage errors. On return, GET to reconcile; never automatically POST on mount. If persistence fails, retain the record in memory and explain that status must be checked before retrying after a reload.
7. Clear the recovery record after a canonical terminal result or definite rejection before recording (for example validation failure). Keep drafts isolated per review. An old unresolved record cannot apply to a new review ID.
8. Refresh review lists/counts and the exact run query plus run lists after a decision. Let existing event polling collect events without resetting its cursor. Do not optimistically mark the run successful.

Post-decision copy:

| Canonical result | Message |
|---|---|
| Approved | “Approval recorded. The runtime will recheck the screen before continuing.” |
| Rejected | “Rejection recorded. The run is stopping before this action.” |
| Expired | “This review expired. The pending action was not approved.” |
| Cancelled | “This review was cancelled. Check the run for its final state.” |
| New pending review for the same run | “Another action or changed screen needs review.” Link to that new review; require a new decision |

Offer **View run** after any result. Continue observing the run so failures after approval remain visible. Do not say “Task completed” until the existing run outcome supports that statement.

### Polling and run integration

- Share query keys and one polling owner per data set: review list, selected review, global pending count. Use 1 second while visible and 5 seconds while hidden, consistent with existing run behavior. Refetch on focus/reconnect; use the existing bounded/backoff read-error policy. The empty pending queue still polls for new entries.
- Stop selected review polling once terminal, but keep the queue polling and the selected run's normal active polling. A previously approved review can stay selected while a banner links to a new pending review for that run.
- Unmounting cancels reads, not the run. Closing the page leaves Node waiting until decision, expiry or cancellation.
- Add `awaiting_human` to `ACTIVE_STATUSES` and `CANCELLABLE_STATUSES` in `runs.ts`. This also prevents `useRunEvents` from mistaking it for terminal and stopping its drain loop.
- Add the central badge **Awaiting review** with a caution tone, the runs-list status filter, and a run-detail banner with **Review action** linking to `/handoffs` for that run.
- Replace misleading “Running tool” progress while waiting with **Waiting for human review**. If the run status arrives before its review list, show a loading/rechecking state without inventing a review.
- Preserve existing Cancel run control and endpoint; after cancellation refresh review/run state and disable pending decision controls. Cancellation is separate from rejecting an action, and earlier actions may already have completed.
- For validation child runs, link the review to the child's actual `run_id`. Parent discovery may remain `validating`; show the child's awaiting-review badge/CTA in the existing pipeline area. Do not rewrite the review owner to the parent.
- Render `human_review_snapshot`, `human_review_requested`, `human_review_decided`, `human_review_expired`, `human_review_cancelled`, `run_awaiting_human` and `run_resumed` events with readable labels, retaining closed raw event details. Correlate exact review IDs, event sequences and call IDs; do not use array indexes or fabricated replay step IDs.

## 4. File map and sequential implementation tasks

Paths in this section refer to the **Lovable console repository**, not the backend checkout holding this plan.

### Task 1 — Baseline and generated contract

**Modify:** `contracts/openapi.json`, `src/lib/api/types.gen.ts`, `src/lib/api/client.ts` (generated type aliases only as needed).

- [ ] Record current Lovable SHA and run the existing test/typecheck/build/lint baseline.
- [ ] Import the pinned backend contract and regenerate types with `bunx openapi-typescript@7.13.0 contracts/openapi.json -o src/lib/api/types.gen.ts`.
- [ ] Confirm generated review schemas and `RunStatus` include the fields/statuses above. Preserve unrelated endpoints and exports.
- [ ] Check configured deployed `/openapi.json`, `/health/ready` and read-only `GET /v1/human-reviews?status=pending&page_size=1`. Readiness now reports `handoff: "approval_review"`. Missing endpoints or incompatible responses must show an unavailable-contract state; a source merge does not prove deployment.
- [ ] Do not treat a transient general readiness failure as permission to replace real data with mocks. Read/reconciliation of an existing review can still be useful; actual review endpoint responses determine availability.

### Task 2 — Review transport, queries and decision recovery

**Create:** `src/lib/api/human-reviews.ts`, `src/lib/api/human-review-recovery.ts`, `src/test/human-reviews-api.test.ts`, `src/test/human-review-recovery.test.ts`.

**Modify as needed:** `src/lib/api/queries.ts` for shared query exports.

**Interfaces:** Export generated `HumanReviewDTO`, `HumanReviewDecision`, and `ReviewStatus` aliases. `humanReviewsQuery(filters: HumanReviewFilters)` returns TanStack query options for `Page<HumanReviewDTO>`; `HumanReviewFilters` contains optional `status: ReviewStatus`, `run_id: string`, `page: number`, `page_size: number`. `humanReviewQuery(reviewId: string)` returns options for `HumanReviewDTO`. `submitHumanReviewDecision(reviewId: string, body: HumanReviewDecision, signal?: AbortSignal): Promise<HumanReviewDTO>` performs one POST only. Recovery exports `readPendingDecision(apiOrigin: string, reviewId: string): PendingDecision | null`, `savePendingDecision(record: PendingDecision): boolean`, and `clearPendingDecision(apiOrigin: string, reviewId: string): void`; `PendingDecision` is `{version: 1, apiOrigin: string, reviewId: string, runId: string, body: HumanReviewDecision}`.

- [ ] First add failing tests for the named scenarios below and run `bunx vitest run src/test/human-reviews-api.test.ts src/test/human-review-recovery.test.ts`; confirm failures concern the missing feature.
- [ ] Add `humanReviewsQuery({status?,run_id?,page?,page_size?})`, `humanReviewQuery(reviewId)` and `submitHumanReviewDecision(reviewId, frozenBody, signal?)` using existing `apiFetch`.
- [ ] Define query keys under `["human-reviews", "list", filters]` and `["human-reviews", "detail", reviewId]`; use a separate stable pending-count list query at page size 1, shared by shell/page observers.
- [ ] Validate required review fields, enums, nullable fields, finite confidence bounds, arguments object and page shape. Reject inconsistent IDs on detail/mutation responses. Use generated types for signatures and runtime guards for transport trust.
- [ ] Implement the submission/reconciliation state machine and bounded read requests. Keep HTTP 409, 422, 404, uncertain transport and contract errors distinguishable.
- [ ] Test exact payload reuse, null versus zero confidence, identical-comment idempotency, conflicting status/comment, lost response followed by approval, pending retry, malformed response, inaccessible status, reload recovery and a different review becoming selected during the request.
- [ ] Rerun the two focused test files; require all to pass before consuming these interfaces in the UI.

### Task 3 — Replace the existing mock route

**Modify:** `src/routes/handoffs.tsx`, `src/components/console/AppShell.tsx`, `src/components/console/primitives.tsx`.

**Create:** `src/components/console/HumanReviewPanel.tsx`, `src/components/console/HumanReviewDecisionForm.tsx`, `src/test/human-review-ui.test.tsx`.

**Interfaces:** `HumanReviewPanel({reviewId, expectedRunId?}: {reviewId: string; expectedRunId?: string})` owns the selected detail/run queries and renders `HumanReviewDecisionForm({review}: {review: HumanReviewDTO})`. The form owns the decision state machine and consumes Task 2's transport/recovery functions; do not duplicate mutation logic in the route or shell.

- [ ] Add failing UI tests for selection, eligibility and decision recovery using intercepted transport; run `bunx vitest run src/test/human-review-ui.test.tsx` before implementation.
- [ ] Remove `DemoStoreProvider`, `useDemo`, synthetic assets and `HandoffPanel` from the live route. Leave unrelated mock modules alone unless proven unused and safely removable.
- [ ] Implement queue, filters, pagination, independent selected detail and validated deep links.
- [ ] Implement screenshot, visible action details, reason/policy/assessment, audit history, deadline and decision controls as specified.
- [ ] Replace the sidebar Mock pill with the real pending count. Preserve the Handoffs route and sidebar slot on desktop/mobile.
- [ ] Reuse existing component spacing/type/theme. Use a list/detail layout on desktop and stacked detail on narrow screens. Ensure keyboard-accessible selection, labeled inputs, focus recovery, status announcements and no color-only meaning.
- [ ] Test empty/loading/stale/error states, exact screenshot selection, pagination/counts, run mismatch, pending-to-terminal transition, comments, concurrent decisions, unavailable image, expiry and a replacement review ID.
- [ ] Rerun `bunx vitest run src/test/human-review-ui.test.tsx`; require all new tests to pass.

### Task 4 — Connect awaiting review to the rest of the console

**Modify:** `src/lib/api/runs.ts`, `src/routes/runs.index.tsx`, `src/routes/runs.$id.tsx`, `src/lib/api/diagnosis.ts`, and central badges in `primitives.tsx`.

**Create:** `src/test/human-review-run-lifecycle.test.tsx`.

**Verify existing code:** `src/lib/api/events.ts`, `src/lib/api/assets.ts`, `src/components/console/AssetImage.tsx`. Change these only if a demonstrated gap prevents the specified behavior.

- [ ] Add failing lifecycle tests proving `awaiting_human` is active/cancellable and events continue polling; run `bunx vitest run src/test/human-review-run-lifecycle.test.tsx` before changing the status sets.
- [ ] Treat awaiting review as active/cancellable; add the filter, badge, progress state and review CTA.
- [ ] Keep run/event/evidence polling alive through `awaiting_human -> running -> terminal`, including validation child runs and final event drain.
- [ ] Add readable review failure explanations for `HUMAN_REVIEW_REJECTED`, `HUMAN_REVIEW_EXPIRED`, `HUMAN_REVIEW_CANCELLED`, `HUMAN_REVIEW_UNAVAILABLE`, `HUMAN_REVIEW_API_ERROR`, `HUMAN_REVIEW_API_TIMEOUT`, `HUMAN_REVIEW_PROTOCOL_ERROR`, `REVIEW_BROWSER_UNAVAILABLE`, and `REVIEW_STATE_UNSTABLE`, without suppressing the actual diagnostic code/details.
- [ ] Distinguish rejected-before-dispatch from failures after approval; never assert that the whole task made no changes. Retain existing domain/READ_ONLY failure handling.
- [ ] Test cancellation during review, queued subsequent runs, approval followed by failure, a changed-screen second review, and parent/child validation ownership.
- [ ] Rerun `bunx vitest run src/test/human-review-run-lifecycle.test.tsx`; require all new tests to pass.

### Task 5 — Documentation, browser checks and delivery

**Modify:** `AGENTS.md`, `UX-CONTRACT.md`, `VERIFICATION.md`; update obsolete `/handoffs` assertions in the existing routing/integration tests intentionally.

- [ ] Replace synthetic-only/deferred handoff instructions with this real approval-only contract. Full manual takeover remains outside scope.
- [ ] Record files changed, contract revision, saved Lovable SHA, commands/results, browser checks and limitations.
- [ ] Run focused new tests, then the full commands below once changes settle. Fix new regressions; do not weaken unrelated assertions to manufacture a green baseline.
- [ ] Test desktop/mobile and light/dark themes using intercepted synthetic API fixtures. Ensure fixture decisions never leak to the real backend. Verify correct request body, no automatic POST retry and no call to runtime review creation.
- [ ] Return the saved revision and verification report. Do not publish or change the target application.

## 5. Acceptance matrix

| Case | Required observable result |
|---|---|
| READ_WRITE action requires review | A real API row appears; run badge says Awaiting review; correct action/screenshot visible |
| Point click versus reference click | Both show their real target arguments and can be reviewed; no invented classification |
| Low confidence | `auto_approve` at 0.29 explains review; 0.3 is not labeled below threshold; missing is distinct from 0 |
| Approve | One POST for the selected review; approval recorded, then run proceeds as reported by API/events |
| Reject | One rejection POST; run stops before this action, with specific outcome; no manual resume |
| Expire | Canonical expired status, disabled controls, final run outcome eventually visible |
| Cancel run | Existing cancel endpoint; review closes; page does not keep an actionable stale review |
| Network loss after POST | GET reconciliation finds the recorded decision; no duplicate automatic POST or opposite choice |
| Still pending after uncertainty | Explicit same-body retry only after fresh eligibility check |
| Two tabs decide concurrently | Canonical first decision wins; 409 reconciles without overwriting |
| Different comment on same decision | Conflict is not mistaken for this client's successful submission |
| Refresh/navigation | Unresolved decision recovers by exact review ID; no automatic POST on mount |
| Screenshot change after approval | New review ID receives a fresh decision; prior approval stays historical |
| Approval followed by failure | Approved review remains approved; run failure is shown separately |
| Replay / validation | Fresh review associated with the actual replay/validation run; no reused approval |
| READ_ONLY or hard domain failure | Existing failure details, no intervention bypass |
| API old/unavailable | Honest contract/error state, no seeded reviews or local-only success |
| Missing signed image | Honest evidence error, no unrelated/latest/mock screenshot |
| Sequential worker | Next run stays queued while current run awaits review; resolving it permits normal worker progress |

Run in Lovable's console repository:

```sh
bunx vitest run
bunx tsc --noEmit
bun run build
bun run lint
```

The inspected `VERIFICATION.md` records a historical baseline of 101 tests, 95 passing and six existing UI regression failures (dismiss/reopen, drawer focus, gallery selection). Capture a fresh baseline before implementing; report any remaining failures by test name and whether pre-existing. Do not use these historical counts as evidence for the new work.

UI fixture tests establish frontend behavior, not a hosted end-to-end run. After the target app receives an appropriate Save operation and the compatible backend is deployed, separately perform two controlled READ_WRITE runs: approve a Save action and verify runtime continuation plus the actual persisted result; reject it on a fresh run and verify that pending Save was not dispatched. Also verify expiry and subsequent queued-run progress. Until then explicitly label this live demonstration pending.

## 6. Copy-ready Lovable execution instruction

Attach this entire file to the existing AI Agent Console project and send:

> Implement the attached human-review plan in this existing AI Agent Console project (`6f60c709-4fda-4f4e-8a77-4430b0d24c22`). Reuse the current Handoffs `/handoffs` tab for real approval/rejection decisions per review and run. Follow the exact backend contract, file map, recovery behavior, lifecycle changes and acceptance checks in the attachment. The approved scope is frontend integration only; the backend feature already exists. Replace the tab's synthetic takeover controls and update its obsolete mock-only documentation. Preserve other console behavior and current styling. Do not build browser streaming/manual control, add backend/auth/database infrastructure, modify the target application, or publish. Inspect current source and baseline first, implement sequentially, then return changed files, saved revision, focused/full test results, browser-fixture evidence, pre-existing failures and any deployed-contract blocker. An approval records permission; only subsequent runtime events/outcome establish execution and completion.
