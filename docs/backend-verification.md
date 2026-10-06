# Backend verification — 2026-10-07

Implementation is on `main`, in B1–B8 order, followed by documentation. Frontend steps F1–F4 remain planned separately. No push/deployment/provisioning/submission was performed.

- Schema/service/read foundation: eight SQLite tables, migration rollback/version checks, typed DTOs, deployment CAS, restart persistence and CORS/error checks.
- Private storage: test SDK verified SHA/dimensions and external signer selection; evidence ACK follows upload and SQL commit. Upload failure produces truthful metadata and stops further action. Backup/restore and conservative cleanup are tested.
- Worker/bridge: awaited async audit, ACK ordering/rejection, serialized execution, restart interruption, crash mapping, cancellation before dispatch and after delayed provider reply.
- Replay/discovery: real Chromium synthetic lookup for two inputs, declared not-found, fresh duplicate-target evidence, scoped duplicate resolution, bounded wait recovery and pre-action crop correlation. RGB shift/duplicate/flat-reference cases and the two-second performance gate pass. Scripted discovery checks observed plan/outputs and retains inline image history.
- Publication/actions: explicit schema reuse checks; rollback, cancel/config conflict, immutable publication, stable old binding, explicit activation CAS, exact admitted selection snapshots, input failure before admission, full-queue rejection before row creation, idempotency recovery and filtered event cursors.
- Python/Node integration: actual supervised child + real Chromium + screenshot staging/upload/event persistence + ACK and terminal output, using a **test SDK**, not an actual MinIO service. Replay constructs no provider client.
- Export: immutable definition hash, per-file SHA-256, asset/event joins, PNG bytes and failure before package creation when storage is missing.

Final verification after the review fixes: `npm test` passed **74 tests** across 21 files, with one environment-gated live-provider test skipped. `backend/.venv/bin/python -m pytest backend/tests -q` passed **31 tests**. TypeScript typechecking, Prettier, Ruff checks and Ruff formatting all passed. Python reported one Starlette TestClient/httpx deprecation warning. Scripted/fake-model results are not genuine provider evidence.

One fresh whole-implementation review found seven Important defects and no Critical or Minor findings. Each defect was reproduced by a failing regression test and fixed in one consolidated pass before the full green suites:

1. Shutdown now interrupts pending jobs without dispatching another browser.
2. Cancellation signals an active validation retry and settles queued source/child bundles.
3. Validation cancellation produces a complete, readable outcome DTO.
4. Business outcomes can reference only results available at their main-step position.
5. Python and Node share tested email validation cases, including defaults.
6. Control text checks compare captured rendered text independently of accessible names.
7. Navigation requires trusted URL bindings; bare tenant URL strings are rejected.

Execution decisions, in order:

- Work directly on `main` as explicitly requested. Cost if wrong: local commits need relocation; no remote was changed.
- Use Python 3.12 and bundled Node 24 because shell Node 23 violates the existing engine range. Cost if wrong: another supported runtime needs verification.
- Track B1–B8 stages instead of frontend-interleaved task numbers. Cost if wrong: bookkeeping differs; the stage commits preserve the sequence.
- Treat test SDK and scripted-model results as local mechanics checks, with genuine provider, actual MinIO, Docker and hosted acceptance pending. Docker's local daemon is unavailable. Cost if wrong: these environments may reveal failures that local checks cannot cover.
- Preserve the existing trusted policy and exclude handoff, new guardrails and candidate provisioning as locked cuts. Cost if wrong: those capabilities require a separately scoped implementation.
- Use standard Ruff syntax/import checks and Prettier without a new lint-policy workstream. Cost if wrong: additional lint rules may surface stylistic issues later.
- Retain the planned deterministic matcher and its fixture performance threshold; broad visual generalization remains unverified. Cost if wrong: other interfaces may fail to resolve and need calibration.
- Exclude frontend implementation, deployment and submission under this backend request. Cost if wrong: integrated UI/hosted acceptance remains outstanding.
- Keep the finished commits on `main`, following the user's explicit branch choice. No merge, push or PR decision is needed. Cost if wrong: integration into another repository remains manual.

No review findings were deferred. B1–B7 implementation and B8 export support are complete; the genuine B8 demonstration remains an external acceptance gate. D1 backend setup/report documents are complete, while the combined frontend phase gate remains outside this request.

External gates currently unavailable: `OPENROUTER_MODEL` and MinIO endpoint/public endpoint/bucket/access/secret settings. Server API-key presence is checked without printing it. No actual MinIO privacy/signature/browser-expiry smoke check, genuine model publication scenario, genuine submission evidence package, Docker build or Railway deployment is claimed. Configure the ignored `.env` or server environment and follow README to finish these checks. One successful paid discovery scenario is sufficient; do not repeatedly invoke paid discovery to repeat already-covered failure tests.
