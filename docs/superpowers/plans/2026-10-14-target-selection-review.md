# Artifact target selection review implementation plan

> Execute the user-approved design in this chat using focused backend/runtime workers and a reviewed console update. User authorization: implement the agreed flow and push to remote.

**Goal:** Remove discovery recorder uniqueness rejection and let artifact execution pause for a human target choice when fresh matching is ambiguous or finds no target.

**Architecture:** Reuse durable reviews, acknowledged screenshot evidence and the same waiting Node browser. Reviews gain optional target candidates; decisions gain a selected candidate ID or a refresh request. The chosen target applies only to the pending execution; artifacts stay immutable.

**Tech stack:** FastAPI/SQLite, TypeScript/Playwright, existing React Handoffs console.

## Constraints and contract

- Preserve confidence-based action approvals, hard domain/browser checks, the sequential worker, expiry/rejection/cancellation, and exactly-once dispatch.
- Target choice is separate from risk assessment and available for either access policy; ordinary READ_ONLY risk reviews remain disabled.
- `target_resolution`: optional `{reason: "ambiguous" | "not_found", candidates: [{id, label, bounds: {x,y,width,height}}]}`. Candidate bounds refer to the exact persisted screenshot.
- `selected_candidate_id`: optional nullable string in decision and response; approved target reviews require an offered candidate ID OR `refresh_targets: true`, never both.
- `refresh_targets`: optional boolean, false by default; recorded approval with this flag re-runs resolution and opens a fresh review without dispatching.
- Empty candidate sets offer Refresh targets and Stop; no arbitrary screenshot clicking or browser takeover.
- Changed UI invalidates the choice and requires new review. The normal absent-target hidden-wait success condition stays intact.

## Tasks

- [x] Backend: failing tests for candidate validation, missing/unknown selection, conflicting retries, refresh, READ_ONLY target selection and legacy migration. Add minimal migration and DTO/service/route fields; regenerate OpenAPI. Run focused and full backend checks.
- [x] Runtime: failing browser/bridge tests for choosing the second Save exactly once, no-match alternatives, zero candidates, refresh, changed context and rejection/expiry/cancel. Remove recorder uniqueness guards; resolve through reviews and fresh candidate snapshots without replay LLM calls. Run focused and full runtime checks.
- [x] Console: add optional-contract parsing, target radios, numbered screenshot bounds, selection/refresh decision payloads and recovery equality. Preserve ordinary review behavior. Test backend error, uncertain response and restored decision selection.
- [x] Integrate: run a real HTTP + Node + Chromium target-choice case; verify selected button only, correct outputs, one dispatch and review evidence under both access policies.
- [x] Review the combined backend/runtime contract and console diff; resolve correctness findings. Commit only task files, push and verify remote SHA as the final delivery step; report deployment and live UI verification separately.

## Verification

- Runtime: 274 tests passed; one existing opt-in paid live-provider test skipped. TypeScript and changed-file Prettier passed.
- Backend: all 89 tests passed, including real HTTP/Node/Chromium candidate selection under both access policies. Ruff and changed-file formatting passed; the existing Starlette/httpx warning remains.
- Generated backend OpenAPI matches the checked-in contract. The console uses the exact six updated schemas and generated types.
- Console source saved remotely at `e74b7db99502921a042b25c5e9b56fa6428ffcf9`: 34 focused tests passed; typecheck, lint and build passed. Full suite: 129 passed, six existing baseline failures. Production publishing is separate.
- Reviewer findings corrected: screenshot-only matching, bounded cancellation/geometry reads, detached-frame recapture, valid flat-reference escalation, and persisted console outcomes/highlights after reload.
