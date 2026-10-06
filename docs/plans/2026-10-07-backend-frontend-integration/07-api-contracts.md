# Typed control and read API implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. This document is the canonical HTTP contract for backend and Lovable prompts.

**Goal:** Manage runs/artifacts and expose real evidence/catalog/deployment/binding data to the existing interface.
**Architecture:** Versioned JSON API, asynchronous starts/actions, cursor polling for events and paged collection reads. Backend lifecycle is authoritative; frontend requests and displays.
**Tech stack:** FastAPI/Pydantic, OpenAPI JSON, TypeScript generated DTOs + explicit UI selectors.
**Spec:** [00](00-context-and-index.md), [01](01-schema-and-migrations.md), [05](05-discovery-and-publication.md), [06](06-artifact-and-deterministic-replay.md).

## Global constraints

`/v1` prefix. UUIDs are opaque strings on wire. UTC ISO timestamps. No auth/protected routes in this phase. No generic capability mutation, candidate provisioning, handoff, pause/resume, policy mutation, direct tool execution or public asset upload endpoint. Do not reinterpret CORS as security. HTTP field names snake_case.

## Review focus

Request timeout does not mean a run wasn't created. Polling uses sequence, not timestamps. Explicit artifact pin never drifts to latest. Deployment config changes invalidate readiness, not past records. Input errors remain inline without synthetic failed runs.

## Common DTOs and lifecycle semantics

`AppDeploymentDTO` = all minimal fields in 01 including `app_deployment_id,tenant_id,product_id,base_url,environment,ui_variant,vendor_release,config_version,created_at,updated_at`. No tenant/product registries or frontend `config_profile` authority. Existing display labels can show IDs; don't invent a registry to retain mock Tenant A names.

`CapabilityDTO` = `capability_id,name,description,input_schema,output_schema,created_at` plus **derived** counts `{published_artifacts,ready_bindings,runs}` on list/detail responses. Optional deployment readiness is fetched by bindings read, not persisted on capability.

`RunDTO`:

```json
{"run_id":"<uuid>","kind":"discovery","purpose":"user","app_deployment_id":"<uuid>","deployment_snapshot":{"app_deployment_id":"<uuid>","tenant_id":"tenant_demo","product_id":"memberdesk","base_url":"http://127.0.0.1:4173","environment":"demo","ui_variant":"standard-v1","vendor_release":null,"config_version":1},"capability_id":null,"task":"Look up demo@example.test","inputs":{},"pinned_artifact_id":null,"artifact_version":null,"artifact_definition_sha256":null,"finalized_artifact_id":null,"parent_run_id":null,"binding_id":null,"binding_version":null,"binding_snapshot":null,"selection_source":"discovery","status":"queued","outcome":null,"stop_reason":null,"runtime_result":null,"progress":{"last_event_sequence":1,"current_step_id":null,"completed_steps":null,"total_steps":null},"created_at":"2026-10-07T00:00:00Z","started_at":null,"finished_at":null}
```

Deployment snapshots use exactly the deployment fields shown above, excluding created_at/updated_at (selection does not depend on those audit timestamps). `artifact_version/hash` are frozen selection values from admission or publication, not joined dynamically to a newest artifact. Persist selection in the explicit `artifact_version`, `artifact_definition_sha256`, `selection_source` columns defined in 01. `selection_source` enum discovery/binding/explicit_artifact/validation. Replay task null; inputs flat typed JSON. Discovery inputs update after parameter extraction with an event showing extraction, never change caller original task (original request also in run_queued payload).

Statuses:

| Status | Meaning and permitted next transitions |
|---|---|
| queued | Admitted, memory queue only -> running/cancelled/interrupted |
| running | Active child -> awaiting_finalization (discovery), completed/failed/cancelling/interrupted |
| awaiting_finalization | Successful observed discovery awaiting draft preparation -> validating/failed/cancelling/interrupted |
| validating | Source discovery bundle has active linked validation -> completed/failed/cancelling/interrupted |
| cancelling | Stop requested, no new dispatch -> cancelled/interrupted (may contain uncertain last action) |
| completed | Terminal verified success OR declared expected business outcome; no active session |
| failed | Terminal hard failure/unverified/runtime stop/finalization failure; explicit unchanged-draft revalidation may reopen source to validating |
| cancelled | Terminal user cancellation; outcome=null, stop_reason USER_CANCELLED with dispatch_state |
| interrupted | Terminal lost process/shutdown; outcome=null, stop_reason PROCESS_RESTARTED/SERVICE_SHUTDOWN; explicit unchanged-draft revalidation may reopen source |

For validation jobs themselves use queued/running/completed/failed/cancelling/cancelled/interrupted; no nested validation. Running discovery does not have a known total step count: show status/current tool, not a simulated percent. Replay progress counts artifact steps; event count is separate and can increase during recoveries.

`OutcomeDTO` = `{kind:"success"|"expected_outcome"|"hard_failure",code,message,outputs:object|null,failure_stage:null|"input_validation"|"readiness"|"execution"|"finalization"|"storage",step_id:null|string,expected:null|object,observed:null|object,dispatch_state:"not_dispatched"|"completed"|"uncertain"}`. Recoverable is an event result kind `{kind:"recoverable",code,message,attempt,max_attempts}`; it is not terminal successful outcome by itself. Cancelled/interrupted are lifecycle stops with stop_reason, not business/crash outcomes.

Existing runtime mapping: business_outcome -> completed/expected_outcome with declared code; unable_to_complete, agent_stopped_unverified, max_tool_calls_reached, provider_error, tool_error, policy_blocked, needs_intervention -> failed/hard_failure with corresponding stable code and original sanitized runtime_result. Existing needs_intervention closes the child/browser and yields RUNTIME_STOPPED_REQUIRES_HUMAN (message that live handoff is deferred), not a waiting_handoff state/request. awaiting_artifact_design -> awaiting_finalization, never terminal success. Runtime successful draft stays incomplete until publication in 05.

`ArtifactDTO` = envelope + full definition (06), `assets:ArtifactAssetMetadata[]` from separate table, derived `publication:{binding_action:"initial_ready"|"unchanged"|null,binding_id:null|string}` and exact lineage `{source_run_id,validation_runs:[ids],replay_count}`. Draft capability/version can be null and displayed as Draft, not invented v1. Published capability/version nonnull. Metadata/list can omit full definition via ArtifactSummaryDTO. Versions grouped by capability_id (no mock `family` field required); same capability may have variant-specific implementations.

`BindingDTO` = row fields from 01 plus derived `readiness:{state:"ready"|"validation_needed"|"incompatible",reason,validation_run_id}`. No binding is a separate pair readiness `{state:"discovery_needed",binding:null}`. Metadata mismatch -> incompatible; changed config/missing valid hash check -> validation_needed. Ready means configured binding backed by validation at current config; **every run still performs fresh entry checks**. Do not say a historical check proves current UI compatibility.

`RunEventDTO` exactly `{run_id,sequence,timestamp,type,step_id,payload}`; discovery step_id null. GET events response `{items,next_after_sequence,has_more,run_status}`. Payload variants tool_started/tool_finished include call_id/tool/current input/result/error/dispatch state, check_finished includes check_id/verdict/expected/observed, target_resolution_finished as 06. Asset summaries returned separately through reads. First run event is run_queued; lifecycle events run_started/run_completed/run_failed/run_cancelled/run_interrupted, artifact_draft_created/validation_started/artifact_published/binding_activated. No human request/action/control-transfer events added.

`EvidenceAssetDTO` = asset fields in 01; no URL, no artifact_id. `ArtifactAssetDTO` has artifact_id, reference crop metadata/provenance, no run evidence masquerading. GET content-url returns SignedAsset from 03. Gallery may include derived run outcome diagnosis separately, never fabricate screenshot bytes.

Collections: `{items:T[],total:int,page:int,page_size:int}`. Query sorting uses `order_by` + `direction` (asc/desc); runs preserve current UI headers with order_by created_at/started_at/run_id/status/app_deployment_id; null started_at sorts after real values with created_at/ID tie-breakers. Artifact q matches capability name/artifact ID/variant. page>=1, page_size 1..100 default20; UI evidence asks8, runs asks5. Filters combined AND, q case-insensitive task/name/label text only; stable order created_at then ID, with deterministic tie-breaker; clamp page to last page if filter/deletion leaves it out of range. Empty collection page1/total0. Events use sequence cursor rather than page. Define all allowed filter/sort fields below and reject unknown order fields with422.

Error envelope:

```json
{"error":{"code":"INPUT_CONTRACT_INVALID","message":"Inputs do not match the pinned capability contract","details":{"fields":[{"path":"inputs.email","code":"format","message":"Enter an email address"}]},"retryable":false},"request_id":"<uuid>"}
```

400 invalid cursor/JSON semantics; 404 unknown entity; 409 status/config/binding/idempotency conflict; 422 request/schema/input validation; 503 queue full/unready/storage/unavailable asset; 500 sanitized unexpected persistence error. No stack traces/raw credentials/value echoes. 202 only after run admitted/persisted. POST starts/revalidate use required `Idempotency-Key` UUID; exact normalized request hash stored in runs. Same key/body returns original202 RunDTO (including terminal state); differing body409 IDEMPOTENCY_CONFLICT. GET `/v1/runs/by-request/{key}` enables recovery after timeout (404 means no record at that read, retry same key once; never regenerate while outcome uncertain). PATCH/activation use expected versions; no standalone idempotency table.

## Endpoint contract and ownership

| Method/path | Request / response | Service and scope |
|---|---|---|
| GET `/v1/app-deployments` | filters q/environment/product_id/tenant_id; order created_at asc/desc; Deployment page | Deployment reads; no candidate joins |
| GET `/v1/app-deployments/{id}` | AppDeploymentDTO | Detail config |
| POST `/v1/app-deployments` | `{tenant_id,product_id,base_url,environment,ui_variant,vendor_release?:null|string}` ->201 DTO | Register minimal target only; UUID/config_version=1 server; no capability binding provisioning |
| PATCH `/v1/app-deployments/{id}` | `{expected_config_version,base_url?,environment?,ui_variant?,vendor_release?}` ->200 DTO | CAS increment config_version; no new deployment on upgrade; tenant/product identity immutable in v1 |
| GET `/v1/app-deployments/{id}/bindings` | `{items:BindingDTO[],pairs:[{capability_id,readiness,binding_id?}]}` | Current/history for this deployment; include published capability catalog pair readiness |
| GET `/v1/capabilities` | q; page; name asc/desc -> Capability page | Stable catalog, counts; no keyword routing |
| GET `/v1/capabilities/{id}` | DTO + ArtifactSummary list (paged separately if large) | Contract/detail |
| GET `/v1/bindings` | app_deployment_id/capability_id/artifact_id/state; page -> Binding page | Exact history; useful artifact detail joins |
| POST `/v1/app-deployments/{id}/bindings/{capability_id}/activate` | `{artifact_id,validation_run_id,expected_binding_version:int|null,selection_note?:string}` ->200 BindingDTO | Lifecycle only; source artifact discovered/validated on same deployment/current config; null expected version only if no active; preserves history. No cross-deployment activation |
| POST `/v1/runs` discovery | `{kind:"discovery",app_deployment_id,task,inputs?:{}}` ->202 RunDTO | RunService validates deployment/task nonblank, preserves NL; no capability ID needed |
| POST `/v1/runs` replay | `{kind:"replay",app_deployment_id,artifact_id,inputs}` ->202 RunDTO | Exact artifact; published and same-deployment current successful validation required; schemas/server entry metadata checked; matching current binding snapshotted if exists, else explicit pin/no binding |
| POST `/v1/capabilities/{id}/invoke` | `{app_deployment_id,inputs}` + Idempotency-Key ->202 RunDTO | Internal/agent resolved ID use: resolve current ready binding atomically at admission; no semantic NL routing in Python; pins exact artifact/config |
| GET `/v1/runs/by-request/{key}` | RunDTO or404 | Lookup before dynamic run ID route |
| GET `/v1/runs` | q/kind/purpose/status/app_deployment_id/capability_id/artifact_id/parent_run_id; order_by created_at/started_at/run_id/status/app_deployment_id, direction asc/desc; page -> Run page | Lists actual discovery, validation and replays; artifact_id matches pinned OR finalized ID |
| GET `/v1/runs/{id}` | RunDTO | Progress/outcome/snapshots |
| GET `/v1/runs/{id}/events` | after_sequence>=0, limit1..200 default100, type optional -> cursor envelope | Authoritative sequence order; type-filtered cursor advances to last scanned sequence so it doesn't loop |
| POST `/v1/runs/{id}/cancel` | `{}` ->202 RunDTO; terminal noncancelled409 | Ordinary cancellation only (04) |
| GET `/v1/artifacts` | q/capability_id/state/product_id/ui_variant/source_run_id; page; created_at asc/desc -> summary page | Include draft states for run details; default published for catalog |
| GET `/v1/artifacts/{id}` | ArtifactDTO | Immutable read, draft inspectable |
| GET `/v1/artifacts/{id}/deployments` | `{items:[{deployment:DTO,eligibility:"eligible"|"validation_needed"|"incompatible",reason,validation_run_id:null|string}],total}` | Only source deployment scope in this phase; no cross-deployment candidates/provisioning. Eligibility based on actual validation + metadata, fresh checks still mandatory |
| POST `/v1/artifacts/{id}/validate` | `{app_deployment_id,inputs}` + Idempotency-Key ->202 validation RunDTO | Same source deployment only; draft unchanged-hash revalidation or published current-config validation. No user finalization/publish endpoint |
| GET `/v1/evidence-assets` | run_id/kind/run_kind/purpose/event_type/artifact_id/q; page; captured_at asc/desc -> evidence page | artifact_id joins source + all pinned runs; event_type joins composite event key; no crops in this collection |
| GET `/v1/artifacts/{id}/assets` | ArtifactAssetMetadata page | Reference crop collection |
| GET `/v1/evidence-assets/{id}/content-url` | SignedAsset | Existing known evidence asset only |
| GET `/v1/artifact-assets/{id}/content-url` | SignedAsset | Existing known crop only |

Representative future starts:

```json
{"kind":"discovery","app_deployment_id":"<deployment-uuid>","task":"Look up synthetic member demo@example.test and report status"}
{"kind":"replay","app_deployment_id":"<deployment-uuid>","artifact_id":"<exact-published-uuid>","inputs":{"email":"other@example.test"}}
```

Discovery accepts unknown operations and a new capability proposal later, rather than requiring matchCapability/extractInputs client heuristics. No automatic "match existing then replay" mode in this phase; composer starts discovery and catalog-aware LLM decides reuse/new. Typed replay/invoke execute saved artifacts deliberately.

Revalidation semantics: source failed/interrupted draft may move source -> validating under explicit revalidation; success publishes it once. For a published artifact, validation creates a new validation run on current source deployment config; immutable artifact `validated_run_id` remains original publication provenance. Eligibility/readiness queries find the latest completed success for exact hash + deployment config in validation run records. A published-validation failure does not mutate source publication or active history. Store `validated_definition_sha256` in validation result_json and verify on activation/admission. Cross-deployment validate returns409 CROSS_DEPLOYMENT_VALIDATION_DEFERRED.

All starts check model/storage/worker readiness relevant to mode; readonly health/catalog remains available if model unset. No public artifact or crop upload API. Backend automatically finalizes after validation; existing FinalizePanel becomes publication status, not a button that fabricates an artifact.

## Task 1: Read DTOs and pagination

**Files:** `backend/interface_api/{dto,api,services}.py`, `backend/tests/test_reads.py`.
**Interfaces:** typed service read functions by endpoint, Pydantic response models; generate OpenAPI via `/openapi.json`.

- [ ] Pin reads: unknown ID404, empty page stable, deterministic tie order, events paginated across >100 records without loss/duplicates including type filter; evidence joins source+replays and excludes crops; draft lineage visible before publication.
- [ ] Run `python -m pytest backend/tests/test_reads.py -q`; implement minimum queries/DTOs and require PASS. Contract fixtures consumed by frontend in 09 must be captured from real DTO serialization, not mock seed conversion.

## Task 2: Starts, cancellation and lifecycle actions

**Files:** above plus lifecycle/worker; `backend/tests/test_api_actions.py`.

- [ ] Tests: nonblank unknown NL task accepted; typed replay invalid input422 no dispatch/no admitted run; idempotent start same key one run; conflicting key409; queue full503 before row; bound invoke records exact historical snapshot; config CAS conflict; no candidate provisioning side effect on POST deployment; activation/validation outside source deployment rejected.
- [ ] Preserve request schema validation vs runtime failure distinction. A queued valid run may fail fresh entry check with readiness stage; schema invalid start doesn't fabricate run events. Clients display HTTP field errors inline.
- [ ] Validate deployment URLs http/https, no embedded credentials; action tool/policy/server adapter never selectable in requests. This is contract validation using existing protections, not a new security workstream.
- [ ] Gate: API action suite PASS; OpenAPI schemas have no app_instance_id or waiting_handoff; only listed endpoints are present; no client authority to write capabilities/artifacts.
