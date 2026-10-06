# Artifact contract and deterministic replay implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. Replay makes no LLM decisions and adds no new policy/handoff system.

**Goal:** Execute a saved typed flow with fresh targets, deterministic checks and clear business/recovery/failure results.
**Architecture:** Frozen artifact definition describes steps/targets/checks/bindings, independent of raw events. Replay captures fresh state, resolves targets, constructs current typed inputs and dispatches through existing tools. Python supervises/persists; Node executes.
**Tech stack:** TypeScript/Zod/Playwright, existing dispatchTool, PNG decoding and deterministic template matcher.
**Spec:** [00](00-context-and-index.md), [01](01-schema-and-migrations.md), [05](05-discovery-and-publication.md), [07](07-api-contracts.md).

## Global constraints

No historical observation/control/call IDs or source_tool_call_id in artifact steps. No recorded global coordinates. Pin artifact ID/version/hash on every replay (draft ID/hash for validation). Product/UI release compatibility is metadata; fresh entry checks determine current usability. Never retry a dispatched mutation blindly.

## Review focus

Duplicate semantic matches stop before dispatch. Visual ambiguity/below-threshold stops with fresh screenshot. Output shape/check failures cannot report success. Defined not-found is a business result. A supported metadata variant with a changed actual UI must still fail entry checks.

## Artifact definition v1

Envelope has `artifact_id`, `capability_id?`, `version?`, `state`, `source_run_id`, `schema_version:1`, `tool_contract_version:1`, `definition_sha256`, `created_at/published_at`, `validated_run_id`. The immutable `definition` contains:

- `surface:"browser"`, compatibility `{product_id,ui_variant,vendor_release:null|exact string}`; no broad guessed version range. `vendor_release:null` means unspecified, not all releases proven.
- `input_schema`, `output_schema`: JSON Schema 2020-12 closed flat objects; primitive string/number/boolean, scalar enum, required, description, email format, minimum/maximum, typed default. Reject nested schemas/$ref/arbitrary external formats in v1, return SCHEMA_UNSUPPORTED, not silently flatten them. Shared capability contract equality uses normalized schema comparison.
- `entry`: trusted `environment.base_url` binding + optional literal relative path, and typed entry checkpoints. No tenant URL literals, credentials or client-selected adapters.
- `steps`: ordered unique stable step IDs; tool name, `arguments` binding tree, optional target(s), `required_matches` normally 1, pre/post checks and bounded recovery rules.
- `success_checks`, `business_outcomes` with code/message/typed conditions/output mappings; no arbitrary expressions, scripts or eval. `output_mapping` maps declared outputs to extracted result fields or literal values.

Binding DSL tagged values: `{kind:"literal",value:<primitive/array/object>}`, `{kind:"input",path:"email"}`, `{kind:"step_output",step_id:"s005",path:"fields.status.value"}`, `{kind:"environment",path:"base_url"}`, `{kind:"url",base:{kind:"environment",path:"base_url"},path:"/members"}`. Enforce input path declared and step_output refers to a prior step only; nested argument objects may contain these bindings. URL binding permits only relative path on trusted base origin; runtime existing policy still validates navigation. String interpolation is explicit `{kind:"template",parts:[{kind:"literal",value:"Member "},{kind:"input",path:"member_id"}]}` with primitive-to-string conversion fixed; no general template code.

Representative saved step:

```json
{"step_id":"s002","tool":"type_text","target":{"kind":"semantic","role":"textbox","name":{"kind":"literal","value":"Member email"},"exact":true,"scope":null,"required_matches":1},"arguments":{"text":{"kind":"input","path":"email"},"mode":{"kind":"literal","value":"replace"}},"post_checks":[{"check_id":"c002","kind":"tool_verification","expected":"matched"}]}
```

Semantic scope is either null or a durable ordered ancestry description `{role,name,exact:true,frame:{name,url_path}?}`. Add frame/scoped capture support where actual sandbox needs it; do not persist CSS selectors/ref prefixes as substitute names. Repeated roles/names require scope, not choosing first. Parameterized names use the binding DSL. v1 selected demo may use uniquely named controls with null scope, plus a fixture demonstrating scoped duplicates.

Visual saved target:

```json
{"kind":"visual","asset_id":"<crop-uuid>","sha256":"<crop-digest>","matcher":"rgb-template-v1","threshold":0.95,"required_matches":1,"relative_point":{"u":0.5,"v":0.5},"capture_context":{"viewport_width":1280,"viewport_height":800,"device_scale_factor":1,"image_scale":"css","color_space":"srgb"}}
```

Asset metadata stores source crop rect/dimensions/provenance. No saved click x/y or source observation/call IDs in this target. Scrolling/layout may shift an anchor; new match maps it to fresh position. Changed branding/theme/size can break it; no cross-branding generalization promise. Visual targets supported only for runtime tools that already accept point targets (`click`,`type_text`,`scroll`); `press_key`, `select_option`, `check_ui`, `extract_data` retain control-only restrictions.

Saved tools use existing execution vocabulary: observe_ui, navigate, click, type_text, press_key, scroll, select_option, wait_for, check_ui, extract_data. `finish_task` and `request_human` are runtime lifecycle proposals/stops, not saved executable steps. Replay engine produces its final structured result itself.

Checks DSL: each primitive check has unique `check_id` and `kind`; tool checks carry `step_id` (or current step in step-local checks) plus `expected`, field checks carry `actual` binding plus `expected` binding, control checks carry `target` plus literal/bound `expected` for text/value. all/any carry `checks:Check[]`. No check consumes a historical ref. Supported kinds: `tool_status_equals`, `tool_verification`, `field_equals` (typed step-output binding vs literal/input), `control_visible`, `control_absent`, `control_text_equals`, `control_value_equals`. Probe controls on a fresh observation, with exact scopes/counts. A `control_absent` check can deterministically succeed at count=0; action target resolution cannot. Unknown/capture failure never passes. `all`/`any` compose finite checks. Business outcomes probe the known empty-state after search before trying to resolve the member row, then terminate expected_outcome not_found. Success and business outcomes must be unambiguous; both matching is RESULT_AMBIGUOUS.

`business_outcomes` is an ordered finite array `{code,message,after_step_id,checks:Check[],output_mapping:{}}`; it is evaluated only at declared steps against fresh state, with conflicting matches rejected, never first-match guessing. `success_checks` run after all main steps; output_mapping produces declared typed outputs.

No unrestricted graph/loops. Ordered main steps; after-step terminal business conditions; bounded recovery can repeat fresh observation/wait check at most twice at 500 ms intervals or execute one explicitly saved dismiss-interstitial action with its own durable target/check, then return to the next check. Recovery rule shapes are `{recovery_id,on_check_id,kind:"wait",max_attempts:2,delay_ms:500}` or `{recovery_id,on_check_id,kind:"saved_action",max_attempts:1,step:<normal step with globally unique step_id>,then_checks:Check[]}`. Embedded saved recovery steps use stable IDs (e.g. s003_dismiss), count as artifact steps for event linkage, and cannot include further recovery rules. Known interstitial action is dispatched once, never replayed on uncertainty. Existing wait_for timeout remains the adapter's configured deadline. Permission denial/session expired/unknown confirmation/app error are hard failure with specific code and fresh evidence, not automatic human-routing or LLM recovery.

## Task 1: Typed schema, bindings and deterministic result evaluator

**Files:** `src/contracts/artifact.ts`, `src/replay/{bindings,checks,result}.ts`, `tests/unit/artifact-contract.test.ts`, `tests/unit/replay-results.test.ts`; Python mirrored validation in `dto.py`/`lifecycle.py`.
**Interfaces:** `parseArtifact(value:unknown)->ArtifactDefinition`; `resolveBindings(bindings,inputs,priorOutputs,environment)->ToolArguments`; `evaluateChecks(checks,observation,stepResults)->CheckVerdict`; `evaluateResult(definition,stepResults,observations)->RunOutcome`.

- [ ] Tests: reject duplicate step IDs, forward/cyclic refs, undeclared inputs/outputs, unknown tools, stale field names recursively (observation_id/control_ref/tool_call_id/source_tool_call_id), absolute tenant URLs and recorded x/y targets. Literal data cannot bypass forbidden structure checks; inspect entire plan/check/binding trees.
- [ ] Tests: true booleans/numbers stay typed, default applied once, missing required/unsupported schemas reject, bad extracted number/partial output fails; expected not_found completes without member-row action; recoverable wait attempt logged and bounded; ambiguous result fails.
- [ ] Implement closed tagged DSL, no eval/JS expression parser. Validate planned actions by rebuilding their current input and passing existing parseToolAction; don't broaden runtime tool target permissions.
- [ ] Gate: `npm run typecheck` and `npm run test:unit -- artifact-contract replay-results` (or exact Vitest file paths) PASS; Pydantic/TS fixtures round-trip the same definition/DTO contract.

## Task 2: Discovery target recording and pre-action crops

**Files:** Create `src/runtime/target-recorder.ts`, `src/adapters/browser/recording.ts`; modify `src/adapters/surface.ts`, `src/adapters/browser/{capture,browser-adapter}.ts` minimally. Tests `tests/browser/target-recording.test.ts`.
**Interfaces:** `recordDurableTarget(action,currentCapture,recordingHint?) -> TargetCandidate`; `captureReferenceCrop(observation_id,rect,relativePoint)->ReferenceCapture`; browser port exposes current scoped semantic descriptions and permitted image/crop extraction without exporting ElementHandles.

- [ ] Semantic recording derives role/name/ancestor scope from fresh observed control. LLM proposes parameterization (e.g. selected member label bound to input); backend validates its declared paths and fresh validation replay tests it. Equality of displayed label does not prove reusable meaning.
- [ ] A point click requires discovery metadata `visual_reference:{rect:{left,top,width,height},relative_point:{u,v},description}` linked to that **current pre-action observation**. Extend discovery proposal/action side-channel schema so the LLM can specify bounds from actual inline screenshot bytes; runtime checks bounds/point inside crop and image correlation before dispatch. x/y alone cannot finalize a reusable point step. If no trustworthy bounds, fail artifact recording with REFERENCE_BOUNDS_REQUIRED; do not invent a fixed window around click or infer target bounds from a post-click screenshot.
- [ ] Crop includes stable local target context (suggested minimum 32x32, maximum viewport), excludes changing identifiers where possible, and uses pre-dispatch PNG. Check 0<=u,v<1, coordinates finite, rect integer pixels/clipped within screenshot; original point must lie within crop. Backend creates reference UUID and links provenance after normalization in 05. Discovery raw rect and point may exist in events/asset provenance only.
- [ ] Preserve RuntimePolicy projected image rules: if screenshot/crop not permitted, no visual artifact publication. Do not circumvent denied bytes via a second raw capture path. Full pre-action capture may attach to `target_reference_captured` as observation_screenshot; crop becomes artifact_asset after proposal conversion. `tool_finished` still owns post-tool screenshot.
- [ ] Gate: crop bytes match specified pre-action rectangle/hash; target image changes after click demonstrate wrong post-action image is never used; recorder rejects point-only final proposal.

## Task 3: Fresh semantic and visual resolution

**Files:** Create `src/replay/{semantic-target,visual-target,template-matcher}.ts`, modify browser adapter only to resolve fresh scopes/control descriptions. Tests `tests/browser/replay-targets.test.ts`, `tests/unit/template-matcher.test.ts`.
**Interfaces:** `resolveTarget(saved:DurableTarget,fresh:Capture,assets:ReadonlyMap<string,ReferenceAsset>)->Resolution`; Resolution is `{verdict:"resolved",freshTarget:Target,diagnosis}` or `{verdict:"failed",code,expected,observed,diagnosis}`.

- [ ] Capture `both` before each targeted step. Semantic resolution exact role/name in exact scope, require declared match count (v1 action targets=1). Count 0 TARGET_NOT_FOUND, >1 TARGET_AMBIGUOUS. Construct `{kind:"control",control_ref:<fresh-ref>}` with current observation_id. For extract_data resolve each saved field independently on the same fresh capture.
- [ ] Concrete recommended matcher: decode PNG to canonical RGB sRGB with one minimal Node PNG library (recommend `pngjs`, pin during execution). `rgb-template-v1` computes score `1 - sum(abs(referenceRGB-freshRGB))/(255*3*cropWidth*cropHeight)` for all valid integer translations, same scale/rotation only. Threshold 0.95; reject zero/near-zero variance reference (pooled RGB standard deviation <5 on 0–255 scale) as uninformative. Use exact early rejection when accumulated error exceeds total threshold error budget; optimization must not skip threshold-passing placements.
- [ ] Sort thresholded matches by score descending, ties by y then x; greedy suppression of overlapping boxes IoU >=0.5 represents one physical anchor cluster. Require exactly one surviving box, irrespective of highest score. Distinct repeated controls both above threshold are ambiguous. Fixture calibration may justify a higher threshold in a new immutable matcher/definition; never silently lower a published threshold. Performance gate: fixture 1280x800 resolution within 2 seconds on test machine; if it fails, optimize implementation without changing scores/candidate semantics before enabling visual runs.
- [ ] Require saved viewport/device scale/image scale and image dimensions to match fresh capture; adapter screenshots must be viewport pixels with declared CSS scale. No scaling/rotation/OCR/name fallback. Map resolved crop top-left `(mx,my)` plus `(u*cropWidth,v*cropHeight)` to fresh viewport; require inside bounds. This is a newly computed point, not a recorded coordinate. Existing layoutSignature/fresh-observation checks still protect dispatch.
- [ ] Emit `target_resolution_finished` with `{verdict,reason,candidates,required_matches,target,score?,threshold?,expected,observed}` and attach fresh resolution screenshot for pass/failure (03). Runtime fresh IDs belong in event only. No synthetic target_resolution_failed event required; update frontend diagnose to this actual envelope (09).
- [ ] Gate: moved anchor resolves shifted point, two repeated anchors fail, changed theme/scale/crop digest fails, zero semantic matches fail, scoped duplicate succeeds; dispatch spy zero after failure. No LLM client imported/invoked.

## Task 4: Replay orchestrator and validation path

**Files:** Create `src/replay/run-replay.ts`, bridge mode switch; tests `tests/integration/replay-flow.test.ts`, `backend/tests/test_validation_replay.py`.
**Interfaces:** `runReplay(command:ReplayCommand,deps:{adapterFactory,policy,assets},options:{signal,onAudit})->ReplayResult`.

- [ ] Python downloads private referenced crop bytes into trusted staging; verify hash/dimensions before launching replay. Node receives staged file references, never relies on signed URL expiry. Replay starts from deployment_snapshot environment binding, captures entry state and verifies checks before saved actions.
- [ ] For each step resolve bindings -> capture fresh state -> resolve target(s) -> await persisted target-resolution event/evidence -> build current ToolCall with new UUID/current observation_id/refs -> dispatchTool -> await tool_finished/evidence -> capture/evaluate post state -> expected business outcome/recovery/success/failure. Untargeted navigate binds trusted base_url; check/extract keep fresh refs. A non-target step uses tool_started/tool_finished but no fabricated target_resolution_finished.
- [ ] Discard stale refs between steps/after recovery; current dispatcher rejects stale observations. Uncertain/failed tool result never advances as success; mutation retry disabled. Check outputs and success checkpoint before returning success.
- [ ] Validation replay uses exact same orchestrator, draft/hash and deterministic fixture reset from 05. Distinguish purpose in run DTO; validation has parent source and draft lineage even before capability publication.
- [ ] Gate: deterministic fixture genuine browser flow succeeds for two inputs, not-found is expected_outcome, forced duplicate-target fails with fresh evidence, cancellation stops new actions. Model spy throws if called in replay; assert zero calls. Existing browser safety/reference tests continue passing.
