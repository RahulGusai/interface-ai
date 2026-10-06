# Implementation ledger
Plan: docs/superpowers/plans/2026-10-05-runtime-orchestration-implementation.md

Ruling: Preserve non-Git workspace; use this ledger instead of Git-dependent skill scripts/commits. User explicitly requested preservation. Cost: no commit-based checkpoints.
Ruling: New runtime plan wins for adapter lifecycle, provider and budget. Close on every exit including intervention; no takeover/resume is offered. Cost: intervention requires a new invocation.
Pre-flight: Tool schemas -> registry -> dispatcher -> history use one shared public schema set. Browser-private bindings never enter public responses.
Pre-flight: Runtime bootstrap and navigation share URL policy; adapter guards document and resource requests separately, including redirects and click-triggered navigations.
Pre-flight: Native dialogs signal intervention independently of pending action; task cleanup terminates the pending operation. No subsequent mutation may start.
Ruling: Implement surface port as typed tool execution/capture with private browser primitives, avoiding exposure of opaque handles across runtime. Cost: a future desktop adapter must implement the same typed action seam.
Ruling: Malformed JSON strings from a valid provider tool-call envelope are dispatcher errors counted against budget (runtime review focus), while malformed provider envelopes are provider errors. Cost: one counted correction round for malformed arguments.

Runtime Tasks 1–5: contracts/config/prompts, OpenRouter transport, policy/dispatch, ordered history, bounded loop and task-local adapter complete. Initial missing-module tests observed, then 32 unit tests pass on Node 22.19.0.
Task 6: real Chromium action bridge implemented; 5 browser tests pass, including typed semantic/point actions, reference isolation, iframe input, conditions/waits, extraction, navigation guards and dialogs. Expanded verification continues below.
Ruling: ElementHandle bindings are exact captured nodes, not role/name first-match locators. Static labels may share text with controls; test/model consumers must use the published role. Cost: detached nodes require a new observation rather than automatic re-location.
Ruling: Screenshots use Playwright scale=css even at device scale 2; screenshot and point coordinates both remain viewport CSS pixels. Cost: lower-resolution images than device-pixel captures.
Ruling: Any configured sensitive-marker redaction suppresses whole screenshots; no claim of reliable image redaction. Cost: those tasks lose visual fallback.
Ruling: Tool handlers use a shared typed registry delegate into modular browser primitives instead of twelve one-line files. Cost: tool-specific orchestration is centralized in the adapter facade.
Ruling: Public result.model is the literal configured-model to obey the newer plan's instruction not to disclose the configured slug in logs/results. Cost: reproducibility requires the operator's private environment record.
Environment: paid live test blocked by missing OPENROUTER_MODEL. API key presence checked without reading its value. No paid request made.
Dependency note: patched Vitest 4.1.11 replaces initial 3.2.4 after audit identified advisories. npm 10 optional peer resolution crashed; legacy-peer-deps resolved installation of the standalone Node test runner (no Vitest browser plugin).

Pre-review verification (Node 22.19.0): `npm test` -> 43 passed, 1 skipped (paid OpenRouter); `npm run typecheck` -> pass. `npm run demo:computer-use` -> headed Chromium performed type/click/extract, finish rejected ARTIFACT_INTEGRATION_REQUIRED, run awaiting_artifact_design with 4 calls. No genuine LLM request was made.
Dependency verification after exact esbuild 0.28.1 override: install audit -> 0 vulnerabilities. Formatter added/pinned for readable code.
Regression fixes before final review: repurposed same-node controls now reject TARGET_CHANGED; arbitrary extraction keys retain data semantics through schema validation; initial task/assistant history is redacted before provider delivery; browser policy blockers terminate immediately as policy_blocked. All four were observed failing before fixes.
Final review requested as read-only independent review under executing-plans/requesting-code-review. No Git init or remote changes.

Final review findings: Important password evidence exposure, iframe-internal coordinate drift, same-document path-policy bypass, and point typing into retained unrelated focus. Primary added an Important whole-capture deadline gap. Each has a real-Chromium regression observed failing before fixes. No Critical findings or deferred minor findings reported.
Final review fix pass: password value conditions return unknown without evidence; point freshness includes all frame geometries/scroll state; resulting frame URLs and pre-capture URLs are checked; point editing requires hit-tested focus correspondence; capture timeout poisons pending operations until cleanup. Regression diagnostics now inspect public results only, never serialize screenshot bytes on assertion failures.
Final: Ruling: live compatibility review declined because OPENROUTER_MODEL is absent — leave genuine LLM verification explicitly blocked — cost: no claim that a configured model works.
Final: Ruling: reviewer did not establish a resource-redirect bypass — retain the current guarded request implementation and real navigation tests; no unsupported bypass claim — cost: browser policy is not a comprehensive network sandbox.

Final results:
- Runtime Tasks 1–6 implemented and verified. Task 7 CLI, opt-in live harness and developer instructions implemented; genuine model compatibility/execution remains blocked only by missing OPENROUTER_MODEL.
- `npm test`: 51 passed, 1 skipped across 11 files. Includes 35 unit tests, 15 real-browser mechanics/safety tests, 1 scripted-model/real-browser integration, and 1 skipped paid live test.
- `npm run test:unit`: 35 passed after strengthening target-restriction tests to first accept valid control arguments then reject only the target-kind change.
- `npm run typecheck`: pass. `npm run format:check`: pass.
- Final headed `npm run demo:computer-use`: type_text/click/extract_data completed, finish_task rejected at artifact boundary, run awaiting_artifact_design; 4 model-script tool calls.
- No real OpenRouter request; no model compatibility claim; no fabricated capability artifact/replay/human takeover/product UI.
- Final review fix regressions passed; entire suite green. Native select option labels now publish as option controls with parent_ref; accepted human requests retain their sanitized reason. Both gaps were demonstrated by failing tests before fixes.
- Non-Git state preserved. No commit, push, deployment, publication, or screenshot/trace artifact recording.
- No deferred minor review findings. Independent review was performed before the regression fix pass, not repeated afterward; final fixes verified by tests.

Known limitations are in runtime-orchestration-development.md. Existing planning documents remain unchanged as source requirements. The ledger is retained because this workspace has no Git history.
