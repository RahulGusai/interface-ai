# Backend verification — 2026-10-07

Implementation is on `main`, in B1–B8 order, followed by documentation. Frontend steps F1–F4 remain planned separately. No push/deployment/provisioning/submission was performed.

- Schema/service/read foundation: eight SQLite tables, migration rollback/version checks, typed DTOs, deployment CAS, restart persistence and CORS/error checks.
- Private storage: test SDK verified SHA/dimensions and external signer selection; evidence ACK follows upload and SQL commit. Upload failure produces truthful metadata and stops further action. Backup/restore and conservative cleanup are tested.
- Worker/bridge: awaited async audit, ACK ordering/rejection, serialized execution, restart interruption, crash mapping, cancellation before dispatch and after delayed provider reply.
- Replay/discovery: real Chromium synthetic lookup for two inputs, declared not-found, fresh duplicate-target evidence, scoped duplicate resolution, bounded wait recovery and pre-action crop correlation. RGB shift/duplicate/flat-reference cases and the two-second performance gate pass. Scripted discovery checks observed plan/outputs and retains inline image history.
- Publication/actions: explicit schema reuse checks; rollback, cancel/config conflict, immutable publication, stable old binding, explicit activation CAS, exact admitted selection snapshots, input failure before admission, full-queue rejection before row creation, idempotency recovery and filtered event cursors.
- Python/Node integration: actual supervised child + real Chromium + screenshot staging/upload/event persistence + ACK and terminal output, using a **test SDK**, not an actual MinIO service. Replay constructs no provider client.
- Export: immutable definition hash, per-file SHA-256, asset/event joins, PNG bytes and failure before package creation when storage is missing.

The final test totals and review outcome are recorded after the final verification pass below. One historical genuine OpenRouter test is environment-gated and skipped when its explicit live-test configuration is absent. Scripted/fake-model results are not genuine provider evidence.

External gates currently unavailable: `OPENROUTER_MODEL` and MinIO endpoint/public endpoint/bucket/access/secret settings. Server API-key presence is checked without printing it. No actual MinIO privacy/signature/browser-expiry smoke check, genuine model publication scenario, genuine submission evidence package, Docker build or Railway deployment is claimed. Configure the ignored `.env` or server environment and follow README to finish these checks. One successful paid discovery scenario is sufficient; do not repeatedly invoke paid discovery to repeat already-covered failure tests.
