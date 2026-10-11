# Human review implementation

The user approved implementation and remote push of the locked design. Backend and Node only; both Lovable applications are deferred.

## Contract
READ_ONLY retains trusted-rule enforcement without review. READ_WRITE uses per-call execution {decision, confidence, reason}; auto_approve at >=0.3 proceeds, all other/missing/invalid assessments require review. Exact-host navigation and target checks remain hard gates. Same Node/browser stays alive while polling HTTP once per second; one worker slot remains occupied. Replay stores assessments on artifact steps, never human approvals, and makes no new model calls.

Reviews persist in human_review, with status pending/approved/rejected/expired/cancelled. Runtime POSTs a review linked to persisted screenshot evidence and polls GET status. Human decision is atomic/idempotent; expiry and cancellation cannot be overridden. Approval makes the run runnable; runtime revalidates the snapshot before dispatch and creates a new review if it changed. A point whose original layout is invalid must stop rather than click changed coordinates. Restart interrupts all unfinished sessions.

## Tasks and verification
1. Add SQLite migration, review DTOs/service/routes, status transitions, expiry/cancellation/restart reconciliation. Tests must fail first for missing endpoint/state, then prove lifecycle and duplicate/late decisions.
2. Add execution schema/prompt and shared READ_WRITE dispatch routing. Persist artifact step assessments. Add browser snapshot validation and Node HTTP polling using existing evidence ACKs. Test 0.3 boundary, missing/invalid assessment, approval/rejection/cancel, no preapproval write, same-browser continuation, and hard domain/READ_ONLY gates.
3. Wire runtime URL/deadline configuration through Python start envelope, bootstrap trusted runtime observations without fabricating model assessments, update generated contracts, README/report and backend API handoff notes.
4. Run full Node and Python suites, typecheck/lint/schema checks. Fresh whole-change reviewer, fix actionable findings, commit and push codex/human-review; verify remote SHA. No deployment or Lovable changes.

## Rulings
- User explicitly requested implementation of locked decisions: proceed without another design approval.
- Default review deadline is 300 seconds, configurable, using server persisted expiry. HTTP polling runs on loopback by default (PORT or 8000), configured separately from public frontend API URL.
- Browser snapshots preserve current observation bindings; fresh screenshot, DOM/layout fingerprint and target identity checks detect changed review context without dispatching UI events.

## Progress
- Initial checkout clean, branch codex/human-review created.

- Backend/runtime, migration, contracts and documentation implemented. Real HTTP/worker/Node/Chromium tests passed for approval, rejection, expiry, cancellation and slot retention. Discovery/replay retains assessment and requires separate approvals without replay model calls.
- Final verification: 229 Node tests passed (one live-provider skip), 60 backend tests passed, typecheck/Ruff/changed-file formatting/contract exports/diff checks passed.
- Independent whole-change review found the polling deadline race; regression tests reproduced it, server-expiry/final-read fix passed, reviewer rechecked and accepted it.
