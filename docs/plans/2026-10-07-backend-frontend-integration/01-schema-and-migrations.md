# SQLite schema and migrations implementation plan

> For future execution: use superpowers:executing-plans task by task after implementation is requested. Checkboxes describe future work, not completed work.

**Goal:** Persist the eight agreed domain tables and reproduce exact run/artifact/binding selection.
**Architecture:** SQLite relational metadata + validated JSON documents, one Python writer service. Published definitions are immutable, with draft lifecycle and binding history in the same agreed tables.
**Tech stack:** Python 3.12, sqlite3, SQL migrations, Pydantic/JSON Schema.
**Spec:** [00-context-and-index.md](00-context-and-index.md), [06](06-artifact-and-deterministic-replay.md), [07](07-api-contracts.md).

## Global constraints

Exactly eight domain tables; no tenant/product/queue/handoff/compatibility registries. UUIDs assigned server-side; UTC RFC3339 timestamps; JSON encoded consistently and validated at boundaries. No live DB, WAL, staging images or secrets committed. `app_deployment_id` is the canonical name.

## Review focus

Publication rollback must leave no partial capability/binding. A changed deployment cannot retroactively change old run selection. Duplicate/retried starts must return one run. Evidence joins must reject absent events. Process restart must mark lost in-memory work interrupted rather than requeue it. Tests below pin these cases.

## Minimal columns

`TEXT` IDs, timestamps, enums and JSON; `INTEGER` versions/sequences/counts; REAL relative points stored in JSON. All JSON columns use `CHECK(json_valid(...))`; status/kind enums checked. Required unless marked `?`. Foreign keys use RESTRICT/NO ACTION; no cascade deletes in this phase. API translates columns ending `_json` into typed DTO fields without the suffix.

| Table | Columns and purpose |
|---|---|
| `capabilities` | `capability_id PK`, `name`, `description`, `input_schema_json`, `output_schema_json`, `created_at`. Minimal stable shared operation contract; no keywords, tenant ownership or vendor-release fields. Published contracts have no update endpoint. |
| `app_deployments` | `app_deployment_id PK`, `tenant_id`, `product_id`, `base_url`, `environment`, `ui_variant`, `vendor_release?`, `config_version INTEGER >=1`, `created_at`, `updated_at`. Opaque tenant/product strings, not foreign registries. No credentials/config_profile blob. UI variant is required for compatibility; release nullable if the sandbox has no release identity. No uniqueness on tenant/product. |
| `artifacts` | `artifact_id PK`, `source_run_id UNIQUE FK runs`, `capability_id? FK capabilities`, `version?`, `schema_version`, `tool_contract_version`, `state` (`draft`,`validating`,`validation_failed`,`published`), `definition_json`, `capability_proposal_json?`, `definition_sha256`, `validated_run_id? FK runs`, `created_at`, `published_at?`. Definition includes compatibility, contracts and steps/checks/output mappings; capability_proposal stores LLM reuse/new selection/reason separately from executable definition. UNIQUE(capability_id,version) when assigned; positive version. Published requires nonnull capability/version/validation/time. |
| `runs` | `run_id PK`, `kind` (`discovery`,`replay`), `purpose` (`user`,`validation`), `app_deployment_id FK`, `deployment_snapshot_json`, `capability_id? FK`, `pinned_artifact_id? FK`, `artifact_version?`, `artifact_definition_sha256?`, `selection_source` (discovery/binding/explicit_artifact/validation), `binding_id? FK capability_bindings`, `binding_version?`, `binding_snapshot_json?`, `parent_run_id? FK runs`, `finalized_artifact_id? FK`, `task?`, `inputs_json`, `status` (07), `result_json?`, `runtime_result_json?`, `idempotency_key? UNIQUE`, `request_sha256?`, `created_at`, `started_at?`, `finished_at?`, `last_event_sequence INTEGER default 0`. Discovery task required; replay pinned ID required. Validation has parent discovery and pinned draft, no active binding required. Snapshot excludes secrets. Runtime result preserves current engine status; API lifecycle status is separate. |
| `capability_bindings` | `binding_id PK`, `app_deployment_id FK`, `capability_id FK`, `artifact_id FK`, `binding_version INTEGER >=1`, `state` (`ready`,`retired`), `deployment_config_version`, `validation_run_id FK runs`, `selection_note?`, `created_at`, `retired_at?`. UNIQUE(deployment,capability,binding_version); partial UNIQUE(deployment,capability) WHERE state='ready'. Each activation inserts a new row, retires prior ready row in one transaction. No proposal machinery in this phase. |
| `run_events` | `(run_id FK runs, sequence INTEGER>=1) PK`, `timestamp`, `type`, `step_id?`, `payload_json`. Sequence allocated transactionally by Python, never by Node wall time. Payload contains exact permitted runtime inputs/results/IDs and structured diagnosis. No evidence ID arrays. |
| `evidence_assets` | `asset_id PK`, `run_id`, `event_sequence`, `kind` (`post_tool_screenshot`,`target_resolution_screenshot`,`observation_screenshot`), `object_key UNIQUE`, `mime_type`, `sha256`, `byte_size`, `width`, `height`, `captured_at`, `label`, `result?` (`passed`,`failed`), `detail?`. Composite FK `(run_id,event_sequence)` to events. Width/height/bytes >0. One-to-many assets per event. |
| `artifact_assets` | `asset_id PK`, `artifact_id FK`, `kind='reference_crop'`, `object_key UNIQUE`, `mime_type`, `sha256`, `byte_size`, `width`, `height`, `source_run_id FK`, `source_event_sequence`, `source_evidence_asset_id? FK evidence_assets`, `crop_rect_json`, `relative_point_json`, `capture_context_json`, `created_at`. Composite source-event FK; provenance is metadata separate from artifact steps. Crop source may be a private permitted pre-action capture described by that event, not a post-action screen. No source call IDs. |

Circular run/artifact/binding references are nullable at insertion. Create all tables in migration 0001; SQLite allows references to tables declared later. Do not insert fake IDs to satisfy cycles. Source discovery row exists before draft; validation row before linking validated_run_id; binding row before stamping successful discovery. Check cross-row invariants in lifecycle transaction; use triggers to enforce immutable published artifact definition/identity/schema fields and stable capability schemas/name/description. Published artifact updates only unnecessary metadata are also disallowed in this phase; no generic patch.

`result_json` serializes `{outcome,stop_reason,validated_definition_sha256?}`. RunDTO projects outcome and stop_reason separately; validation success records validated_definition_sha256 here for immutable hash/config checks. `artifact_version` on draft validation runs remains null (exact draft ID/hash pinned); original published validation can still be identified after version assignment without rewriting historical run selections.

Useful indexes: runs(created_at DESC,run_id), runs(deployment,status), runs(pinned_artifact_id,created_at), runs(parent_run_id); events(run_id,type,sequence); evidence(run_id,event_sequence), evidence(kind,captured_at); artifacts(capability_id,version DESC); bindings(deployment,capability,binding_version DESC). No speculative search infrastructure.

`deployment_snapshot` contains app_deployment_id/tenant_id/product_id/base_url/environment/ui_variant/vendor_release/config_version (excludes created_at/updated_at). Binding snapshot contains binding ID/version, exact artifact ID, deployment_config_version and validation_run_id. An explicit artifact replay without a matching ready binding records `binding_id/version/snapshot=null` and selection source `explicit_artifact`; it still needs successful same-deployment validation and fresh entry checks (07). This does not provision a binding.

No persisted handoff/ownership state is added. An existing runtime `needs_intervention` stop is stored as a terminal failure with its runtime status and diagnosis; there is no intervention request/control transfer API. Automation activity is derived from run status for display only.

## Task 1: Connection, migrations and invariants

**Files:** Create `backend/interface_api/db.py`, `backend/interface_api/migrations/0001_initial.sql`, `backend/tests/test_schema.py`. Modify `.gitignore` only during execution to ignore `/data/`, `/backend/.venv/`, Python caches and all SQLite sidecars; do not unignore arbitrary existing PNGs.
**Interfaces:** `open_database(path: Path) -> sqlite3.Connection`; `migrate(path: Path) -> int`; `transaction(conn) -> context manager`. SQL helpers never await network/process work inside a transaction.

- [ ] Write tests: a fresh file has exactly the eight domain tables and user_version=1; foreign_keys=ON on every connection; duplicate ready binding, missing event FK, duplicate source artifact and mutation of published definition are rejected. A forced exception in publication leaves the capability/artifact/binding counts unchanged.
- [ ] Run `python -m pytest backend/tests/test_schema.py -q`; initially missing-module failure, then implement minimal helpers/migration and require PASS.
- [ ] Set per-connection `foreign_keys=ON`, `busy_timeout=5000`, database WAL and `synchronous=FULL`. Use short `BEGIN IMMEDIATE` writes for sequence/version/CAS allocation. Run blocking DB calls in a bounded thread executor/`asyncio.to_thread`, serializing writes with one service lock; never share an unsafe connection across threads.
- [ ] Migrate under an exclusive startup application lock before worker/API readiness. Number filenames; apply each SQL body + user_version advance in the same transaction (avoid implicit commits from sqlite3.executescript). Reject a DB version newer than the application. Run integrity/foreign-key checks after migration. No destructive automatic down migrations.
- [ ] Gate: interrupted migration rolls back; a second start is a no-op; newer DB refuses startup with sanitized error. Stage only intended files if a Git repository exists at execution time.

## Task 2: Repository-relative path, Railway persistence and backup

**Files:** Create `backend/interface_api/maintenance.py`, `backend/tests/test_database_lifecycle.py`; configuration owner in 02.
**Interfaces:** `resolve_db_path(repo_root: Path, relative_path: str) -> Path`; `backup_database(db_path: Path, destination: Path) -> BackupManifest`; `restore_database(backup: Path, db_path: Path) -> None` (offline CLI only).

- [ ] Test path resolution independent of cwd and reject traversal outside repository. Recommended `INTERFACE_DB_PATH=data/interface-ai.sqlite3`; repository root is found from installed backend package location, not request or cwd. Tests may inject a temporary repo root.
- [ ] Plan Railway image WORKDIR `/app`; repository copied there; mount a user-provisioned volume at `/app/data`. Application DB remains `/app/data/interface-ai.sqlite3`; WAL/SHM/backups/staging use the same volume. Match `RAILWAY_VOLUME_MOUNT_PATH` to resolved data directory and fail hosted startup if absent/mismatched. Never silently create an ephemeral production DB.
- [ ] Run migrations at runtime startup, not build/pre-deploy; the [Railway volume is only mounted when the container starts](https://docs.railway.com/volumes). Mount only data, not the repository root, so source files remain available.
- [ ] Implement CLI `python -m interface_api.maintenance backup --output data/backups/<UTC>.sqlite3`; use sqlite3 connection backup, `PRAGMA integrity_check`, foreign_key_check and manifest schema version/checksum. [The backup API makes a consistent snapshot](https://www.sqlite.org/backup.html); copying the live main file alone can omit WAL data. Keep DB+WAL together on the persistent filesystem ([WAL constraints](https://www.sqlite.org/wal.html)).
- [ ] Before each schema upgrade, take a backup. Keep three recent local backups as a recommended minimal retention; an off-volume copy/manual download is an operational prerequisite for disaster recovery, not delivered by Git or an automatic infrastructure job. DB backup references existing MinIO object keys; object backup/retention is a separate user operation.
- [ ] Restore only with service/worker stopped: validate backup then replace DB and remove old WAL/SHM safely, never while writers are active. Test restore preserves event order, exact artifact, binding history and old deployment snapshot after a configuration update.
- [ ] Gate: restart service against same data path retains rows, a configuration upgrade increments config_version, and old runs remain unchanged. Railway redeploy proof is a later operational check; local restart is not deployment evidence.

## Task 3: Minimal repositories

**Files:** Create `backend/interface_api/repositories.py`, `backend/tests/test_repositories.py`.
**Interfaces:** `Runs.create(request, snapshot, idempotency) -> RunRecord`; `Runs.transition(run_id, expected_status, new_status, result=None) -> RunRecord`; `Events.append_with_assets(run_id, event, assets) -> RunEvent`; `Lifecycle.publish_validated(discovery_id, draft_id, validation_id) -> Publication`; `Deployments.update(id, expected_config_version, patch) -> AppDeployment`.

- [ ] Implement only operations used by 03–07, with parameterized SQL and no generic repository framework.
- [ ] Pin tests: same idempotency key/body returns same run; changed body conflicts; concurrent CAS updates cannot both succeed; event sequences are contiguous and rollback consumes no sequence; retired binding row preserves old exact pin.
- [ ] Gate: `python -m pytest backend/tests/test_repositories.py -q` passes. Keep one coherent transaction for publication; MinIO uploads precede it as specified in 03.
