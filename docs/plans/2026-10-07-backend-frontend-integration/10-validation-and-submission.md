# Phase validation and assignment evidence implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. No public repo/email submission, provisioning, publishing or deployment is authorized here.

**Goal:** Prove the authorized backend/frontend slice and create a small permitted submission evidence package.
**Architecture:** Meaningful boundary/failure tests, then one genuine LLM discovery with deterministic validation/replays, then real UI verification. Export authoritative SQLite/MinIO records, not UI screenshots as replacement for logs/artifact.
**Tech stack:** pytest/httpx, existing Vitest/Playwright, existing OpenRouter, private MinIO, JSON/JSONL export.
**Spec:** [00](00-context-and-index.md), [08](08-cuts-and-future-architecture.md), [11](11-combined-execution-order.md); assignment PDF Sections3/6.

## Global constraints

This pass delivers current phase only. Handoff and new guardrails are deferred core assignment requirements, report-only; no acceptance tests require real takeover/resume here. Preserve existing runtime protections and use permitted synthetic data/fixture. No secrets/real PII/live database in export. Local checks are not deployment proof.

## Review focus

Fake-model tests do not prove real discovery. A historical awaiting_artifact_design run does not prove new publication/replay. Artifact export must match frozen DB hash and image bytes. Cancellation/crash must not be reported successful. Phase completion must not imply full assignment completion.

## Minimal validation matrix

| Boundary | Necessary assertion | Owner |
|---|---|---|
| DB migration/publication | Rollback, FKs, one ready binding/pair, immutable schema/definitions, old config snapshots | 01/05 tests |
| MinIO/event persistence | Bytes before metadata, truthful capture/upload failure, no orphan rows, signature external host/expiry | 03 tests + one actual existing MinIO smoke check |
| Bridge/worker | Awaited event ACK, one active child, abrupt exit, restart interrupts not requeues, cancellation prevents next action | 04 tests |
| Capability/artifact | LLM explicit reuse/new, reject contract drift/stale IDs/point without crop bounds, hash-linked validation, first atomic binding | 05/06 tests |
| Replay | No model calls, unique fresh semantic/visual target, moved anchor, duplicate anchor, bounded read recovery, business outcome distinct | 06 browser/unit tests |
| API | Typed422 vs runtime failure, same-key start/timeout recovery, config/binding CAS, paged events/evidence joins | 07 tests |
| Frontend | Query cancellation/stale responses, typed boolean/number/default form, event cursor drain, signed refresh, direct links/mobile/themes | 09 tests/browser checks |

Test boundaries once; don't add one test for every presentation component or every schema property already validated by library. Existing regression suites are valuable because adapter/runtime changes can break current protections. After passing relevant checks, don't repeat broader checks without new changes/failure.

## Task 1: Select/reset safe demo fixture

**Files:** Create `tests/fixtures/replay-member-desk/index.html`, `tests/helpers/replay-fixture.ts`, `tests/integration/replay-flow.test.ts`; reuse `tests/helpers/fixture-server.ts` with htmlOverride where useful, preserve `tests/fixtures/legacy-app/index.html` and its regression cases unchanged. Future exact commands documented in README; leave Meridian/Lovable legacy app untouched.
**Interfaces:** `startReplayFixture(options:{syntheticMembers,duplicateTarget?,transientLoad?,visualAnchor?})->{url,reset,close}`.

- [ ] The inspected existing legacy fixture has only Member ID42 -> inline result, plus dialog/frame/reference tests; it does not contain a search-detail flow. Add a dedicated small replay fixture with Member email textbox, Search button, parameterized member result link, member detail region and labelled Status text. Two synthetic members have fixed statuses and missing email yields a labelled Not found empty-state. This planned fixture is test/demo setup, not a rewrite of Meridian or Lovable.
- [ ] Use member lookup with two synthetic email inputs and known displayed status + not_found empty state. Preserve a nontrivial search -> detail -> extract/check flow. Fixture data is safe/synthetic. Do not bypass UI to perform the task; fixture reset/test setup only may use local harness controls outside artifact.
- [ ] Include one scoped duplicate semantic control, one shifted visual anchor/duplicate crop case and one transient read/wait condition to prove target/error semantics. These are bounded test fixtures, not extra product features.
- [ ] Genuine discovery finalization extracts reusable inputs/outputs and deterministic plan from LLM-driven UI interactions; validation starts from reset fixture. For mutation demonstration, use dedicated resettable synthetic fixture with cleanup explicitly recorded; no repeat live production mutation as validation.
- [ ] Gate: scripted browser tests show success, expected-outcome, recoverable read, and hard target failure; no new guardrail/handoff implementation required.

## Task 2: Genuine end-to-end backend run and UI

**Future commands:** From repository, `npm run typecheck`, `npm run test:unit`, `npm run test:browser`, `npm run test:integration`; from configured backend, `python -m pytest tests -q`. Actual Node binary must meet existing engines. Genuine paid discovery uses configured OPENROUTER_API_KEY/OPENROUTER_MODEL; missing model is a blocked genuine check, not a passed mock substitution. Do not print env values.

- [ ] Start actual backend/fixture with temporary repo-relative DB data directory and user-existing MinIO. Register one minimal deployment through POST. Submit natural-language discovery, inspect real model/tool events and inline screenshot correlation. Only one successful paid scenario is necessary; bounded diagnosis of failure before repeating, no automatic paid test loop.
- [ ] Require source run completes only after draft deterministic validation completed success, artifact published and initial ready binding exists atomically. Source run is one artifact, validation replay purpose/parent/draft ID visible. No historical GLM artifact copy substitutes this check.
- [ ] Replay published exact artifact for a second input, require outputs and zero provider calls. Run expected not-found and one injected fresh target-resolution failure with proper diagnosis and fresh screenshot. API field-invalid input422 proves no dispatch. Preserve failed target evidence even without tool_finished.
- [ ] Verify ordinary cancellation, fake child crash/restart and storage upload error through test harness rather than paying for redundant provider calls. Record uncertainty if a mutation was in flight; no success claim.
- [ ] UI accepted start/reload, exact lineage/pin/config/binding version, evidence images/expiry, v2 publication retains binding until deliberate activation. Apply frontend stages only after listed endpoints pass. Mobile/theme/disclosure checks from09.
- [ ] Gate: a written verification record states scripted tests vs genuine model evidence, local vs hosted checks, and any skipped/missing external check. /handoffs remains mock/deferred/no production calls; no takeover gate for this pass.

## Task 3: Export permitted repository evidence package

**Files:** Create `backend/interface_api/export.py`, `backend/tests/test_export.py`; future output `/evidence/example-member-lookup/` only after actual successful new flow.
**Interfaces:** `export_example(source_run_id: str, replay_run_ids: list[str], output_dir: Path) -> ExportManifest`; CLI `python -m interface_api.export --source-run <id> --replay-run <id> --replay-run <exception-id> --output ../evidence/example-member-lookup` from backend.

- [ ] Export `artifact.json` (exact published envelope/definition), `discovery-events.jsonl`, `validation-events.jsonl`, `replay-events.jsonl`, `exception-replay-events.jsonl`, `runs.json`, `artifact-assets.json`, `evidence-assets.json`, permitted `images/` PNG/crops, `manifest.json` SHA-256/IDs/hashes/version/config selections, and `README.md` explaining genuine vs injected evidence and reproduction commands.
- [ ] Read persisted authoritative events/assets and privately download bytes by object key. Never export expiring signed URLs, live DB/credentials/raw forbidden payloads. Existing runtime policy projection applies; synthetic-only example must be checked for secrets/real PII. Export is explicit one package, no general data retention/guardrail subsystem.
- [ ] Reference images locally in exported metadata through a separate `export_path` mapping keyed by asset ID; preserve original object keys for provenance if appropriate but not signatures. Artifact definition unchanged except no modifications: hash must match frozen definition. Manifest records byte checksums and selected IDs; no stale tool IDs added to artifact steps.
- [ ] Test export joins each asset to correct event/artifact and hashes match actual bytes; missing asset fails export clearly rather than declaring package complete. Future .gitignore narrow exceptions only for selected permitted evidence PNGs; current `*.png` ignores them by default, do not broadly unignore artifacts.
- [ ] Gate: exported example independently parsed/inspected and deterministic replay demonstrated; `/evidence/` directory exists separately from `/evidence` viewer.

## Task 4: Assignment setup/write-up (future documentation work)

- [ ] Update root README with actual dependency/config setup, offline scripted tests vs required genuine model run, exact future API/discovery/replay/export commands and minimal deployment registration. Explain local API+Node vs Railway headless seam, volume path/backup and user-existing MinIO. No false deployment claim.
- [ ] Create root `REPORT.md` about1–3 pages with exact seven headings: **Architecture**, **Artifact schema**, **Determinism & error handling**, **Heterogeneity & multi-tenant**, **Escalation & handoff**, **Safety**, **Cuts**. Discuss tradeoffs/limitations rather than reproducing all plans.
- [ ] Escalation & handoff states core requirement deferred; existing runtime halts/ends session, UI simulated only; report future same-session/remote seam without implementing it. Safety describes existing protections and deferred new guardrail work. Cuts records excluded candidate provisioning, auth, broker/scaling, remote viewer, new policy controls and limitations of visual matching across variants.
- [ ] Record current phase completion separately from assignment readiness; full assignment still requires separate handoff/guardrail scope resolution. Future public repository push/email requires direct authorization; do not submit from this plan.
