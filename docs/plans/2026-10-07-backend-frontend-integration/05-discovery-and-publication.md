# Discovery and atomic capability publication implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. No standalone capability CRUD or cross-deployment provisioning is added.

**Goal:** Turn a genuine successful run into one validated reusable artifact and the deployment's first ready binding.
**Architecture:** Existing Node LLM loop receives catalog/context and proposes a structured durable plan. Python lifecycle validates, prepares draft/assets, executes linked deterministic validation, then publishes in a single SQLite transaction.
**Tech stack:** Existing OpenRouter/typed tools + Zod, Pydantic/JSON Schema, sqlite3, MinIO.
**Spec:** [01](01-schema-and-migrations.md), [04](04-worker-and-node-bridge.md), [06](06-artifact-and-deterministic-replay.md), [07](07-api-contracts.md).

## Global constraints

LLM owns semantic capability selection, Python owns validation/IDs/persistence/publication/binding. Identical names do not establish equivalent operations. Reuse pins the existing typed contract. No success until observed goal/output checks AND deterministic validation pass. Human finalization mocks are not backend authorities.

## Review focus

A successful narrative/final_text cannot publish. A reused capability with changed schemas is rejected. Artifact plans cannot smuggle stale refs/global points. Validation of a different hash/configuration cannot publish this draft. A second artifact publication cannot move the ready binding automatically.

## Task 1: Discovery context and typed final proposal

**Files:** Create `src/contracts/{capability,artifact,discovery-proposal}.ts`, `src/runtime/discovery-context.ts`; modify `src/runtime/{prompts,finalization,run-task}.ts`, `src/contracts/{tools,finish-task.draft}.ts` at finalization contract only. Keep existing CLI path supported, without claiming persistence for CLI-only use. Python DTOs in `dto.py`, lifecycle in `lifecycle.py`. Tests `tests/unit/discovery-proposal.test.ts`, `backend/tests/test_discovery_contract.py`.
**Interfaces:** `DiscoveryContext={deploymentSnapshot,capabilityCatalog,requestedInputs}`; `validateDiscoveryProposal(proposal,context,observedResults)->ValidatedProposal`; `prepare_draft(source_run_id: str, proposal: DiscoveryProposal) -> ArtifactDraft`.

- [ ] Tests: final_text remains agent_stopped_unverified; goal_achieved without durable plan rejected; reuse unknown ID/schema drift rejected; new capability name collision permitted as distinct proposal but never auto-reused; business outcome is separate and does not create a capability/artifact.
- [ ] Build catalog from backend capability DTOs `{capability_id,name,description,input_schema,output_schema}` and include it in discovery system/task context. Natural language goal is passed unchanged, with deployment snapshot base_url used by trusted service to build current TaskInput; client never sends arbitrary target URL in run start.
- [ ] Replace draft finish schema with versioned proposal on goal_achieved: typed capability_selection, input/output contract, parameterized plan, typed checks/output mapping and compatibility. For non-success retain explicit business_outcome/unable_to_complete semantics. No Python/regex heuristic selects the capability before execution. A frontend routing preview must not reject unknown goals.

Representative selection shapes (candidate envelope, not artifact definition):

```json
{"mode":"reuse","capability_id":"<existing-uuid>","reason":"Same member lookup operation and existing typed contract"}
{"mode":"new","name":"Look up member status","description":"Search a synthetic member and return displayed status","reason":"No catalog operation covers this result","input_schema":{"type":"object","properties":{"email":{"type":"string","format":"email"}},"required":["email"],"additionalProperties":false},"output_schema":{"type":"object","properties":{"status":{"type":"string"}},"required":["status"],"additionalProperties":false}}
```

The proposal separately contains `parameter_values` extracted by LLM from task/explicit inputs, `observed_outputs`, `definition` (06), and `reference_assets` provenance/staging handles. Validate conflicts with explicit typed inputs; reject missing/invalid values rather than dispatch guesswork. Replay input params persist with true number/boolean types. Discovery engine can explore first; required finalization params must validate before validation replay.

- [ ] Existing syntheticPolicy hardcodes output key member and business code not_found; do not reuse that callback unchanged for the new status-output demo. Bind the existing RuntimePolicy validateOutputs callback to the selected typed contract (existing shared contract for reuse; parsed proposed contract for new, also checked by backend) and retain current allowlist/risk/dialog/redaction/image rules. CLI legacy synthetic behavior remains intact. This is existing contract validation, not a new guardrail workstream; do not replace it with unconditional true.
- [ ] Runtime verifies fresh terminal checkpoint/output shape using rendered observation and existing dispatch/check/extract facilities; model declaration alone is not proof. `finish_task` returns a candidate accepted-for-finalization response, not published success. `runTask` can keep internal awaiting_artifact_design status as bridge intermediate; API maps to awaiting_finalization.
- [ ] Discovery-specific model tool definitions extend point-capable argument schemas with optional `recording_hint` (visual bounds/relative point). `runTask.invoke` separates this hint from proposed JSON before typed dispatch, preserving both proposed input and normalized dispatched input in tool_started payload. The existing parseToolAction receives only its supported arguments; replay does not send recording_hint. A point proposal without the hint may execute in CLI-only discovery, but cannot finalize a visual artifact in API discovery.
- [ ] Add pre-action recorder seam: semantic durable descriptions from fresh controls; point actions require explicit visual crop candidate boundaries and relative click point in discovery side-channel metadata validated before action (06). Preserve original typed action dispatcher; metadata does not become a new raw-browser tool vocabulary. Keep successful tool results plus corresponding durable step candidate separate from raw transcript. Exact source call IDs only in events.
- [ ] Gate: one scripted discovery returns parameterized plan with no transient identifiers and retains inline image history. No runtime success/persistence claimed when API lifecycle not connected.

## Task 2: Draft, validation and publication

**Files:** `backend/interface_api/lifecycle.py`, `worker.py`, `repositories.py`, `backend/tests/test_publication.py`.
**Interfaces:** `prepare_draft(...) -> ArtifactDraft`; `start_validation(draft_id: str) -> RunRecord`; `publish_validated(discovery_id: str, draft_id: str, validation_id: str) -> Publication`; `activate_validated(app_deployment_id,capability_id,artifact_id,expected_binding_version,validation_run_id)->Binding`.

- [ ] Prepare draft after genuine observed goal achievement: allocate artifact UUID; insert one draft per source discovery. For reuse, capability_id known; for new, null until publication and selection/name/description/schemas/reason live in capability_proposal_json, while executable schemas live in definition. Insert draft before crop rows; upload/reference crop conversion uses 03. Candidate `asset_handle`s resolve to backend asset UUID+digest, then recursively reject forbidden artifact fields. Draft has schema/tool version 1 and version=null until published.
- [ ] Use canonical JSON bytes (sorted object keys, preserved array order, finite numbers, UTF-8) + SHA-256 for frozen definition and crop digest set. Freeze before validation. Editing steps/thresholds/schemas after freeze is disallowed; failed draft corrections require a new discovery run, preserving one-artifact-per-source. Same unchanged draft can be explicitly revalidated (07).
- [ ] Source discovery -> validating; insert validation run `{kind:"replay",purpose:"validation",parent_run_id:source,pinned_artifact_id:draft}` with same deployment snapshot and params. Within the active worker's discovery bundle execute validation inline as next child, not enqueue a job and await its own queue (deadlock). Worker stays serialized. Standalone explicit revalidation queues normally.
- [ ] Validation uses the same replay engine as user replay and no LLM. Selected demo fixture is synthetic member lookup, read-only business lookup except UI field entry/navigation. Reset its synthetic state through test harness between discovery/validation; reset is outside artifact and never targets production. A state-changing flow must use a dedicated resettable fixture and defined cleanup/reset before repeated execution; no repeated live mutation assumed safe. Record reset/fixture context in validation events, not a new policy system.
- [ ] Publication transaction rechecks: source not cancelled/interrupted; goal/check/output validation true; validation run completed with success; exact definition+crop hash matches; deployment current config_version equals validated snapshot; reused shared schemas unchanged; all crop metadata confirmed. Validation on not_found alone is not validation of the successful output path.
- [ ] If new, insert capability UUID/name/description/schemas/time; allocate next version under BEGIN IMMEDIATE (new=1; reuse max+1). Stamp published artifact capability/version/time/validated_run_id; link source run finalized_artifact_id/capability_id and mark completed/success; append artifact_published. Validation run remains separate with draft/exact hash linkage.
- [ ] If no binding for this deployment/capability has ever existed, insert version=1 ready binding using validation run/config version, append binding_activated to source. No cross-deployment effects. If pair has an existing/retired history, publish without changing it; run response says `binding_action:"unchanged"` and UI offers deliberate same-deployment activation where valid. Publication and first ready binding are atomic, not separate browser actions.
- [ ] Failed validation -> validation failed + draft validation_failed + source failed with VALIDATION_REPLAY_FAILED, expected/actual/step data. Nothing new in capabilities/ready bindings/published artifacts. Existing published state survives. Upload failure follows 03. Invalid proposal -> source failed ARTIFACT_CONTRACT_INVALID, not successful discovery. Current runtime's business outcome may complete as expected_outcome without publication; unable/final_text/runtime errors fail as 07.
- [ ] Test atomic rollback at each publication mutation, duplicate finalization (returns existing Publication), same reused capability multiple artifacts, late cancellation/config change rejects, later artifact leaves binding stable. Gate `python -m pytest backend/tests/test_publication.py -q` plus TS proposal tests PASS.

## Task 3: Deliberate activation and shared-contract immutability

- [ ] Only same-deployment validated artifact activation in 07. Require latest successful validation for current config/hash, published artifact and matching capability; first discovery ready binding does not need a second manual check. No "latest" request semantics.
- [ ] Compare-and-swap expected binding version; retire old row and insert incremented ready row atomically. Older runs keep binding ID/version/snapshot. After deployment configuration update, readiness reports validation_needed even if row remains ready historically.
- [ ] If a new operation needs different input/output meaning, model must propose a new capability; no automatic schema mutation based on artifact publication. Schema equality is validation, never semantic proof.
- [ ] Gate: activation with stale binding version/config fails 409; a queued replay keeps admission-time pin/config even after later activation, and current live entry checks can still stop it if the target UI changed.
