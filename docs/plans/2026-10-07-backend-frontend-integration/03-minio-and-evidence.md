# MinIO and evidence persistence implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. Assume MinIO service and private bucket already exist; provision nothing.

**Goal:** Store permitted run screenshots and artifact reference crops with truthful metadata and refreshable private access.
**Architecture:** Node stages projected image bytes; Python uploads them, then atomically commits events and asset rows. Object keys survive URL expiry; SQLite owns joins and publication state.
**Tech stack:** Existing PNG screenshot bytes, MinIO Python SDK, sqlite3, SHA-256.
**Spec:** [01](01-schema-and-migrations.md), [04](04-worker-and-node-bridge.md), [06](06-artifact-and-deterministic-replay.md), [07](07-api-contracts.md).

## Global constraints

Artifact crops and run evidence have different tables. No `evidence_asset_ids` arrays in event payloads. Preserve RuntimePolicy image permissions/redaction: policy-projected bytes only; do not upload raw forbidden screenshots to satisfy a plan. Never put only object IDs/URLs into multimodal model messages. No bucket/public policy creation.

## Review focus

Upload timeout can leave an object with an unknown result; commit only confirmed uploads. Successful upload followed by DB rollback creates an orphan, not a fictitious row. A wrong signed hostname cannot be repaired by string replacement. Evidence unavailable is visible in the event without fabricated assets. Crop provenance must reference the pre-action image, not the later tool result image.

## Object contract

Private immutable keys, no user names/emails/task text in paths:

- `v1/runs/<run_uuid>/<asset_uuid>.png`
- `v1/artifacts/<artifact_uuid>/<asset_uuid>.png`

Persist key + bucket from configured store, SHA-256, MIME, byte size, pixel dimensions and capture time. UUID object keys permit targeted cleanup after partial upload; don't overwrite objects to repair a definition. Use `put_object(... length, content_type="image/png", metadata={sha256:...})`; verify completed upload metadata/size (SDK ETag is not the content hash). Calculate hash locally. Validate PNG header/dimensions before upload and ensure match with runtime metadata. Draft crop hashes become part of frozen artifact definition's referenced asset digest set.

## Task 1: Storage client and signed reads

**Files:** Create `backend/interface_api/storage.py`, `backend/tests/test_storage.py`.
**Interfaces:** `put_png(key: str, staged_path: Path, expected_sha256: str) -> StoredObject`; `sign_get(key: str, ttl_seconds: int=300) -> SignedAsset`; `verify_store() -> None`.

- [ ] Test with fake SDK: put/sign uses correct key/hash/dimensions; internal upload endpoint and external signing endpoint differ; expired URL refresh returns same asset ID/key with new expires_at; unknown asset returns 404 without object probing. One actual upload/download/checksum test against user-existing MinIO is needed before end-to-end integration; don't install/provision a storage service for this planning task.
- [ ] Build two SDK clients if required: internal endpoint for bytes, external endpoint for signatures with explicit/cached region; credentials stay backend-only. [MinIO Python API](https://github.com/minio/minio-py/blob/master/docs/API.md) supplies put_object/presigned_get_object. Browser URL must point to reachable S3 service, not MinIO console. Never rewrite signature hostname after signing.
- [ ] SDK calls run off the asyncio loop, with bounded network timeouts; recommend connect3 seconds/read10 seconds and whole-operation deadline20 seconds (bridge ACK30 seconds), no blind retry of unknown-result writes. Recheck exact key metadata before deciding unknown upload result. Signed response `{asset_id,url,expires_at,sha256,width,height,mime_type}` has Cache-Control no-store; signature expiry is 300 seconds.
- [ ] Gate: bucket private, browser loads valid PNG via signed URL; expired URL produces controlled refresh; no access/secret keys or signature URLs in durable event/asset rows.

## Task 2: Event/asset consistency and protocol acknowledgement

**Files:** Create `backend/interface_api/evidence.py`, `backend/tests/test_evidence.py`; use Events repository (01) and bridge (04).
**Interfaces:** `persist_runtime_event(run_id: str, message: RuntimeEvent, staged_assets: list[StagedAsset]) -> PersistAck`; synchronous semantics are exposed as awaited coroutine to bridge.

- [ ] Test success: bytes uploaded first; one DB transaction assigns event sequence, stores event, assets and run.last_event_sequence; every asset joins existing event; ACK follows commit, not upload start.
- [ ] If capture was denied/unavailable, commit original event with payload `evidence:{status:"unavailable",reason:"capture_denied"|"capture_failed"}` and no asset row. Exact permitted tool result still retained. Discovery emits post-tool screenshots only when returned/permitted. Replay target-resolution event must attempt a fresh screenshot even on failure, and report capture failure honestly.
- [ ] If upload fails, commit event with `evidence:{status:"upload_failed",code:"STORAGE_UPLOAD_FAILED"}` and no row for that image; persist sanitized diagnostic, not SDK secrets. Return ACK `continue:false`; stop the run with storage failure before another browser action. This preserves existing audit fail-stop behavior. If the tool already dispatched, annotate `dispatch_state:"completed"|"uncertain"`; never replay it to fix evidence.
- [ ] Multiple images may attach to one event. If some uploads succeed and another fails, retain only confirmed rows in the event transaction and mark partial evidence, then stop. A crop upload failure prevents draft validation/publication; asset-less semantic flows can publish only when permitted evidence/check requirements were met, not fabricated.
- [ ] On DB commit failure, do not ACK continue; try targeted object removal for new keys; stop child. If metadata cannot be written, supervisor marks run failure when DB available; after hard death startup marks it interrupted. Do not promise transactional atomicity between MinIO and SQLite.
- [ ] Gate: inject capture/upload/commit failure and require no fictitious asset, contiguous event sequences and no next mutation.

## Task 3: Private staging, crop provenance and minimal orphan cleanup

**Files:** `storage.py`, `evidence.py`, `maintenance.py`; new Node staging helpers `src/bridge/staging.ts`; tests `backend/tests/test_asset_cleanup.py`.

- [ ] Per-run staging directory under `data/staging/<run_id>` mode 0700; files 0600. Node writes bytes, flushes/closes, then emits a **relative** staged filename/hash/dimensions. Python resolves under that directory, rejects traversal/symlinks and mismatches, and removes staged file after durable ACK. Runtime directory is generated by backend, never supplied by browser/LLM.
- [ ] For visual reference assets, attach the permitted pre-action capture to a discovery `target_reference_captured` event; include original observation/image correlation in that event only. `artifact_assets` references the source run/event and optional evidence row. A crop's rect/capture_context/relative point remain provenance/asset data, not recorded global coordinates in replay steps. Step references asset ID + digest only.
- [ ] Cleanup CLI `python -m interface_api.maintenance cleanup-assets --dry-run`, then explicitly `--apply`: list this application's v1 prefixes, compare keys against both asset tables, skip objects younger than 24 hours and skip live/draft run prefixes; remove only confirmed unreferenced old keys. No recurring scheduler, lifecycle infrastructure or deleting published references. Staging sweep on startup deletes old terminated-run directories after 24 hours, never live ones.
- [ ] Orphan upload diagnostics log sanitized key/hash locally; cleanup can enumerate the known prefix after restart without an orphan table. Asset read missing object reports `ASSET_UNAVAILABLE` 503, not a broken synthesized thumbnail.
- [ ] Gate: dry-run lists only old unreferenced objects; published crop/run screenshot survive; same object hash in export/download verifies byte identity.
