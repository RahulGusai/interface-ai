# Computer-use Foundation Implementation Plan

> **Planning update, 2026-10-05:** [Runtime orchestration and policy plan](./2026-10-05-runtime-orchestration-implementation.md) supersedes this plan's session, provider and discovery-loop assumptions for the first build. Use this document for typed action contracts and browser adapter implementation, adapting its old `Session` references to a private, per-task context. Its Tasks 2, 4, 10 and 11 must be coordinated with the newer plan instead of implemented literally.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method has not been selected; this document does not authorize implementation or agent delegation by itself.

**Goal:** Implement the agreed typed computer-use tools and a session-bound Playwright browser adapter, with hybrid observations/targets, policy enforcement, bounded execution, and visible local browser operation.

**Architecture:** A single process owns isolated sessions. Each session receives its adapter once at initialization; typed tools dispatch through that adapter after runtime validation. Browser mechanics, policy decisions, observation references, and model transport have separate interfaces so future desktop support does not change the core tool contracts.

**Tech Stack:** Agreed: Playwright, Chromium, headed local demo. Proposed: TypeScript, supported Node.js LTS, npm, Zod, Vitest. Choose and pin exact compatible dependency versions when executing Task 1; no packages are installed by this plan.

**Spec:** [Computer-use architecture decisions](../specs/2026-10-05-computer-use-design.md). That document distinguishes agreed requirements from proposed defaults and contains all public tool schemas. Both files must travel together.

## Global Constraints

- Browser-only implementation; adapter selected by trusted runtime configuration and bound once per session.
- Hybrid observation and targeting; screenshot-only observation must be usable without a semantic tree.
- Use one active browser page and a headed window for the local demo. No browser streaming UI in this phase.
- Public tools expose no session selector, raw Playwright objects, arbitrary scripts, arbitrary selectors, or model-controlled timeout.
- `press_key` accepts only optional control targets. `select_option`, `wait_for`, `check_ui`, and `extract_data` accept control targets only.
- `click` and `type_text` require a control or point target. `scroll` accepts either target or no target.
- Runtime owns dialog policy; both runtime and LLM can initiate intervention.
- Do not design or implement the post-intervention takeover/resumption flow here.
- Artifact storage/replay and the final `finish_task` contract remain deferred. No successful discovery finalization without validated artifact persistence.
- No blind retry after an action may have been dispatched. Observe uncertainty and return it explicitly.
- No real financial data or credentials in fixtures, logs, evidence, or repository files.
- Do not initialize Git, install dependencies, start servers, launch browser previews, or run a model while merely reviewing this plan.
- This workspace was empty and was not a Git repository when the plan was written. All source paths below are proposed new files.

## Review Focus

1. A stale reference resolves to a same-named control in a replacement document or frame: reject before input (Tasks 2, 3, 5).
2. A scaled screenshot or scrolled iframe sends input to the wrong location: correct mapping or explicit rejection, never silent drift (Tasks 3, 5, 7).
3. A browser dialog leaves an action pending while the runtime reports a blocker: preserve execution exclusion and no silent dismissal (Tasks 4, 5, 10).
4. A late write or append completes after timeout and gets executed twice: keep in-flight ownership and forbid blind retry (Tasks 4, 6, 11).
5. A screenshot, text value, or trace leaks a synthetic sensitive marker: redact/suppress before model delivery and disk writes (Tasks 3, 9, 11).

## 1. Deliverables and explicit non-deliverables

### Deliverables of this plan

- Public runtime-validated schemas and JSON Schema tool definitions for the 11 stable tools, plus a clearly draft `finish_task` boundary.
- A `SurfaceAdapter` interface and one tested `BrowserAdapter`.
- Session initialization/binding, isolated contexts, one-operation-at-a-time execution, finite limits, observation mapping and invalidation.
- Hybrid observations, real screenshots, semantic targeting, visual primitives, deterministic checks/reads.
- Policy hooks for destinations/actions/dialogs/data exposure, and structured intervention requests from both sources.
- Evidence hooks and a provider-neutral discovery-loop integration boundary.
- Local synthetic browser fixtures and a headed scripted harness proving browser mechanics through the public tools.

### Separate future work

- Capability artifact schema/compiler/store, replay, final completion persistence.
- Full human takeover/resume/control-transfer mechanism.
- Concrete LLM provider/model and genuine LLM-run evidence. The port and scripted tests here cannot substitute for that run.
- User-facing application UI, artifact management, deployment and publication.

The agreed future interface is preserved as a consumer of the session/runtime API. Do not build a placeholder artifact manager or claim the scripted harness is the final product.

## 2. Proposed file structure

```text
package.json                         scripts and dependencies
package-lock.json                    reproducible dependency resolution
tsconfig.json                        strict TypeScript configuration
vitest.config.ts                     unit and browser integration configuration
.gitignore                           dependencies, secrets, generated/raw evidence
src/
  contracts/
    observation.ts                   public observations and target types
    tools.ts                         stable inputs/results and JSON Schemas
    finish-task.draft.ts              provisional finalization input/result
    errors.ts                        common error codes and dialog metadata
  runtime/
    config.ts                        trusted limits, adapter/browser options
    session.ts                       session lifecycle and execution ownership
    observations.ts                  session-scoped reference store/invalidation
    dispatch.ts                      validation, policy, adapter execution, results
    policy.ts                        URL/action/dialog/data policy contracts
    intervention.ts                  shared request port for LLM and runtime
    finalization.ts                  provisional result/artifact integration port
    evidence.ts                      redacted trace/event sink
  adapters/
    surface.ts                       framework-neutral adapter contract
    factory.ts                       startup selection; browser only initially
    browser/
      browser-adapter.ts             Playwright lifecycle and operation facade
      capture.ts                     screenshot/semantic capture and mappings
      targets.ts                     private target bindings and live validation
      navigation.ts                  navigation and destination guard mechanics
      input.ts                       click, text, keyboard, native selection
      scroll.ts                      targeted movement and boundary verification
      conditions.ts                  one-shot deterministic condition evaluation
      extraction.ts                  UI property reads and explicit conversions
      events.ts                      dialog/navigation/frame/closure notifications
  tools/
    registry.ts                      tool names, descriptions, schemas, handlers
    observe-ui.ts
    navigate.ts
    click.ts
    type-text.ts
    press-key.ts
    scroll.ts
    select-option.ts
    wait-for.ts
    check-ui.ts
    extract-data.ts
    request-human.ts
    finish-task.ts                   draft integration; no fabricated persistence
  agent/
    model-port.ts                    provider-neutral tool/image exchange
    discovery-loop.ts                observe, propose, dispatch, bounded continuation
  demo/
    scripted-run.ts                  visible mechanics smoke test, explicitly not LLM evidence
tests/
  helpers/                           fake adapter, session builders, fixture server
  fixtures/legacy-app/                synthetic UI and exceptional-state fixtures
  unit/                              contracts/runtime/model-transport tests
  browser/                           real browser adapter integration tests
docs/
  computer-use-development.md         commands, behavior, limits, deferred work
```

Avoid one generic executor file containing all browser mechanics. Tool handlers should be small and share validated runtime services. They must not receive a raw `Page` from the session.

## 3. Shared internal interfaces

Public input/output definitions are in the spec. Use these internal names consistently across tasks; all browser handles remain opaque outside the browser adapter.

```typescript
type ToolName =
  | "observe_ui" | "navigate" | "click" | "type_text" | "press_key"
  | "scroll" | "select_option" | "wait_for" | "check_ui"
  | "extract_data" | "request_human" | "finish_task";

type ExecutionContext = {
  callId: string;
  deadline: number;            // Monotonic clock deadline
  signal: AbortSignal;
};

type Capture = {
  observation: ObservationResult;
  image?: { ref: string; mimeType: "image/png"; bytes: Uint8Array };
  bindings: Map<string, OpaqueControlBinding>;
  generation: string;
  surfaceId: string;
};

interface SurfaceAdapter {
  readonly kind: "browser" | "desktop";
  readonly capabilities: ReadonlySet<string>;
  capture(mode: ObserveUIInput["mode"], ctx: ExecutionContext): Promise<Capture>;
  resolveTarget(binding: ObservationBinding, target: Target, ctx: ExecutionContext): Promise<ResolvedTarget>;
  navigate(url: string, ctx: ExecutionContext): Promise<NavigationExecution>;
  click(target: ResolvedTarget, ctx: ExecutionContext): Promise<ActionExecution>;
  typeText(target: ResolvedTarget, text: string, mode: "replace" | "append", ctx: ExecutionContext): Promise<TextExecution>;
  pressKey(target: ResolvedControl | undefined, keys: string[], ctx: ExecutionContext): Promise<ActionExecution>;
  scroll(target: ResolvedTarget | undefined, direction: ScrollInput["direction"], distance: number, ctx: ExecutionContext): Promise<ScrollExecution>;
  selectOption(target: ResolvedControl, label: string, ctx: ExecutionContext): Promise<SelectionExecution>;
  evaluateCondition(binding: ValidatedControlBinding, condition: Condition, ctx: ExecutionContext): Promise<ConditionEvaluation>;
  readProperty(binding: ValidatedControlBinding, property: "text" | "value" | "name", ctx: ExecutionContext): Promise<PropertyRead>;
  onEvent(listener: (event: SurfaceEvent) => void): () => void;
  close(): Promise<void>;
}
```

The adapter execution types are internal mechanical outcomes, not public tool results. Define them in `surface.ts`:

- `ActionExecution`: `dispatch: "sent" | "not_sent" | "unknown"`, optional normalized error and side-effect events.
- `NavigationExecution`: action fields plus requested/final URL and readiness result.
- `TextExecution` / `SelectionExecution`: action fields plus matched/mismatched/unavailable verification and permitted selected label.
- `ScrollExecution`: action fields plus moved/no_movement/unknown.
- `ConditionEvaluation`: pass/fail/unknown, optional property evidence and error.
- `PropertyRead`: a permitted value or typed read error; no conversion guesses.
- `SurfaceEvent`: navigation/frame generation change, resize/scroll, dialog, popup, surface closure, or operation-settled notification.
- `ObservationBinding`, `ValidatedControlBinding`, `ResolvedControl`, `ResolvedTarget`, `OpaqueControlBinding`: branded internal types. Define their browser implementation in `targets.ts`; public JSON never serializes them.

Runtime interfaces:

```typescript
createSession(config: RuntimeConfig, deps: RuntimeDependencies): Promise<Session>;
dispatchTool(session: Session, call: ToolCall): Promise<ToolResponse>;
publishObservation(session: Session, capture: Capture): ObservationResult;
validateObservation(session: Session, observationId: string): ObservationBinding;
requestIntervention(session: Session, request: InterventionRequest): Promise<InterventionReceipt>;
```

`ToolCall` contains trusted call ID, name, and untrusted JSON arguments. `ToolResponse` contains the public result and optional permitted image content. `Session` privately stores bound adapter, observation store, policy/config, budget, execution gate and event/evidence subscriptions.

## 4. Implementation tasks

Each task uses a failing behavioral test, implementation, then a targeted check. Schema tests may pass before live browser tests exist; do not count them as browser evidence. Commit checkpoints are optional until the user initializes/authorizes Git work; do not invent a remote or publish.

### Task 1: Establish typed contracts and tool registry

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/contracts/{observation,tools,finish-task.draft,errors}.ts`, `src/tools/registry.ts`; test `tests/unit/contracts.test.ts`.

**Interfaces:** Consumes the spec's public contracts. Produces `toolSchemas`, `toolDefinitions`, `ToolName`, `ToolCall`, `ToolResponse`, all public input/result types, and `parseToolInput(name, args)`.

- [ ] Confirm proposed TypeScript/Node/Zod/Vitest choices before installing; pick compatible pinned releases and record the tested Node/Playwright versions. Create only the minimal project configuration needed for the following test.
- [ ] Write contract tests: reject points for `press_key`, `check_ui`, `extract_data`, `select_option`, and `wait_for`; accept optional targets only where specified; reject unknown timeout/session/adapter arguments, duplicate extraction names, negative/non-finite scroll distances, empty key arrays and sequential-key lists.
- [ ] Run `npm run test:unit -- contracts` and verify the behavioral tests fail because the definitions are absent. Define scripts so `test:unit` means `vitest run tests/unit`, `test:browser` means `vitest run tests/browser`, `typecheck` means `tsc --noEmit`.
- [ ] Implement runtime schemas and derived TypeScript types. Generate model-facing JSON Schema from the same source; do not maintain a divergent manual schema. Use a narrow plain-decimal grammar for number conversion later. Keep `finish_task` in its draft module.
- [ ] Run the contract tests plus `npm run typecheck`; require pass. Inspect generated definitions for accidental Playwright/session internals and test JSON round-tripping.

**Acceptance:** Public definitions describe exactly the accepted contracts. Provider schema-format normalization is a transport concern and must not silently widen optional target behavior.

### Task 2: Bind adapters at session startup and isolate sessions

**Files:** Create `src/adapters/{surface,factory}.ts`, `src/runtime/{config,session,observations}.ts`, `tests/helpers/fake-adapter.ts`; test `tests/unit/session.test.ts` and `tests/unit/observations.test.ts`.

**Interfaces:** Produces `SurfaceAdapter`, `RuntimeConfig`, `RuntimeDependencies`, `Session`, `createSession`, `validateObservation`, `publishObservation`. Factory accepts trusted adapter configuration only.

- [ ] Write `binds_adapter_once`, `rejects_cross_session_reference`, `rejects_replaced_document_reference`, `supersedes_old_public_observation`, and `does_not_restore_old_reference_after_capture_failure`. Assert a fake adapter is constructed once per session and runtime tool arguments cannot select another.
- [ ] Run `npm run test:unit -- session observations`; confirm expected missing-behavior failures.
- [ ] Implement per-session maps, document/frame generation tracking, typed invalidation reasons, bounded retention, and the execution gate. Missing/invalid observation checks happen before target resolution or browser input. Keep evidence history independent from active bindings.
- [ ] Add tests for a same-name control after frame replacement and a second session reusing `obs_017/c1`; neither may resolve using the other context.
- [ ] Run targeted tests and typecheck. Confirm no Playwright import outside `adapters/browser` except browser-specific tests/configuration.

**Acceptance:** Adapter configuration is a startup decision, sessions do not share authority or references, and the model cannot switch either.

### Task 3: Capture browser observations and retain safe bindings

**Files:** Create `src/adapters/browser/{browser-adapter,capture,targets,events}.ts`, `src/tools/observe-ui.ts`, `tests/helpers/fixture-server.ts`, `tests/fixtures/legacy-app/{index.html,app.js,style.css}`; test `tests/browser/observe.test.ts`.

**Interfaces:** Consumes session/store and `SurfaceAdapter`; produces real `capture`, `resolveTarget`, surface events, and `observe_ui` handler.

- [ ] Build a small synthetic fixture with Member ID textbox/Search button, static result text, duplicate labels, an iframe, an unlabelled custom control, delayed UI, and synthetic sensitive markers. The automation must not rely on fixture test IDs or generated element IDs.
- [ ] Write tests for screenshot-only, controls-only, both, incomplete semantics, no-control versus unavailable-tree distinction, actual image payload delivery, and a tree/image capture interrupted by navigation. Run `npm run test:browser -- observe` and confirm failures.
- [ ] Implement browser lifecycle with a fresh context/page per session; headed is the demo default, headless is allowed in automated tests. Fixture server uses an allocated local port and is closed by test teardown; do not hardcode port 3000.
- [ ] Implement semantic capture against the pinned Playwright APIs. For the initial binding strategy, publish semantic references only when an observed node has a uniquely validated, frame-scoped semantic locator or supported exact element binding. If no unambiguous binding is available, retain visual operation rather than inventing a locator. Ordinary fields/buttons must work without test IDs. Static text can use uniquely scoped rendered-text locators; duplicates require scope or remain unsupported.
- [ ] Retain opaque locator/frame/identity evidence privately. Test `obs_017/c1` resolves only the observed Member ID textbox and `c2` only Search; duplicate role/name must never fall back to `.first()`.
- [ ] Capture viewport images with recorded dimensions/scale. Implement redaction/suppression hooks before constructing model-facing content, not after writing a file. Add a scale-factor-2 test and an iframe coordinate test.
- [ ] Run browser observation tests and typecheck. Manually review generated synthetic screenshots only when implementation is authorized; no browser preview is part of this planning task.

**Acceptance:** The LLM receives actual images and structured references; no Playwright objects escape; incomplete semantics do not prevent screenshots. The installed snapshot API is an implementation primitive, not our public reference contract.

### Task 4: Centralize dispatch, policy and browser-event handling

**Files:** Create `src/runtime/{dispatch,policy,evidence}.ts`; extend `session.ts`, `events.ts`, `registry.ts`; test `tests/unit/dispatch.test.ts`, `tests/unit/policy.test.ts`, `tests/browser/dialog-policy.test.ts`.

**Interfaces:** Produces `dispatchTool`, common validation/result translation, `PolicyService`, `EvidenceSink`, `SurfaceEvent` processing. Defines shared structured blocker/dialog metadata used by later tools.

- [ ] Write tests for schema rejection before adapter invocation, action allowlist enforcement, malformed/lookalike URLs, exact origin/path matching, no concurrent mutations, out-of-budget calls, and redacted evidence. Verify failure with `npm run test:unit -- dispatch policy`.
- [ ] Implement dispatch order: schema -> trusted session/ownership/budget -> observation/capability -> target -> policy -> mechanical execution -> evidence -> fresh observation/result. Observations use the appropriate read-only branch; finalization/intervention use runtime ports.
- [ ] Register native dialog listeners before any page action. Route type/context to runtime policy; default unknown dialogs to escalation. Keep HTML-modal recognition separate from native dialog events.
- [ ] Write browser tests for allowlisted alert acceptance, before-unload dismissal, unknown-dialog escalation, and dialog arrival during an action. Assert an escalation can be reported while the underlying action is pending, but a second mutation cannot begin until the pending operation is resolved or terminated.
- [ ] Implement blocker notification independently of the awaited Playwright action. Preserve pending-operation ownership; a timeout or `Promise.race` return does not cancel browser work by itself. Do not implement the future human takeover flow.
- [ ] Run `npm run test:unit -- dispatch policy` and `npm run test:browser -- dialog-policy`; require no unhandled rejections or leaked browser operations.

**Acceptance:** Tools share one enforcement path, dialogs never use accidental default dismissal, and timeouts cannot free a still-running operation for conflicting input.

### Task 5: Implement `navigate` and `click`

**Files:** Create `src/adapters/browser/navigation.ts`, `src/adapters/browser/input.ts`, `src/tools/{navigate,click}.ts`; test `tests/browser/navigation.test.ts`, `tests/browser/click.test.ts`.

**Interfaces:** Implements `SurfaceAdapter.navigate` and `.click`; handlers produce public navigation/action results with fresh observations.

- [ ] Write tests: allowed URL preserves context cookies; forbidden direct and redirected destinations are blocked; a link-triggered forbidden navigation is also guarded; successful navigation to login still reports completed navigation; stale document refs reject without click; overlay/ambiguity do not force clicks.
- [ ] Run `npm run test:browser -- navigation click` and verify expected failures.
- [ ] Implement navigation readiness/deadline from `RuntimeConfig`, URL provenance validation using task/observed links, before-unload policy integration and new-document invalidation. Configure document destination interception separately from allowed resource-origin policy. Reject unsupported new-window flows and record the attempted popup.
- [ ] Implement control click with unique validated binding and actionability; implement point click with bounds/scale/surface validation. Point input must not require a clean semantic DOM, but insufficient safety/target certainty produces blocked/uncertain results.
- [ ] Add tests for a redirect blocked before destination request, same-name controls after replacement, navigation timeout followed by late completion, scrolled iframe targeting, and screenshot dimensions changed before point input. Observe results rather than retrying actions.
- [ ] Run tests/typecheck. Inspect result status and evidence, not just that a Playwright method returned.

**Acceptance:** Direct and indirect navigation respect policy; neither successful clicks nor loaded error pages are mistaken for task success.

### Task 6: Implement `type_text` and `press_key`

**Files:** Extend `src/adapters/browser/input.ts`; create `src/tools/{type-text,press-key}.ts`; test `tests/browser/text-input.test.ts`, `tests/browser/keyboard.test.ts`.

**Interfaces:** Implements `typeText` and `pressKey`; uses shared target validation and policy.

- [ ] Write tests for replace, append-at-end despite a middle caret, disabled/read-only field rejection, coordinate focus, value mismatch/unreadable verification, and no automatic form submission. For `press_key`, test no-target current focus and control-target non-activating focus.
- [ ] Include `focus_button_then_enter_activates_once`: focusing a Search button must not generate a click before Enter. Assert activation count is one. Include schema rejection of point targets and unsupported focus behavior.
- [ ] Run `npm run test:browser -- text-input keyboard` to establish failing cases.
- [ ] Implement actual input interactions and explicit replace/append semantics; never assign hidden application state. A coordinate text action includes the documented policy-checked focus click, followed by editable-focus verification. On unsupported/read-only focus do not send text.
- [ ] Implement one allowed key/chord per call and release modifiers in cleanup. Apply context policy before Enter/shortcuts. Observe autocomplete/autosave side effects.
- [ ] Add a test where entry is dispatched, acknowledgement times out, and the value later changes: result is uncertain, there is no automatic append retry, and pending input stays serialized.
- [ ] Run tests/typecheck. Verify public result meanings: text completion requires matched value; keyboard completion only establishes dispatch.

**Acceptance:** No hidden click in targeted keyboard focus, no typing into an unintended field, and no duplicated entry after uncertainty.

### Task 7: Implement `scroll` and `select_option`

**Files:** Create `src/adapters/browser/scroll.ts`, `src/tools/{scroll,select-option}.ts`; extend `input.ts`; test `tests/browser/scroll.test.ts`, `tests/browser/select-option.test.ts`.

**Interfaces:** Implements `scroll` and `selectOption`; outputs movement/verification and fresh observation.

- [ ] Write tests for default viewport scroll, control/point nested region targeting, distance based on region dimensions, boundary no-movement, parent region not moving, and stale coordinates after scrolling.
- [ ] Write native single-select exact-label success, disabled/missing/duplicate option rejection, and custom-widget unsupported tests. Add a custom-widget primitive path: click -> observe -> click option, demonstrating the hybrid fallback explicitly.
- [ ] Run `npm run test:browser -- scroll select-option` and verify failures.
- [ ] Implement targeted scrolling of the selected rendered region with boundary isolation, bounded settling and measured movement; do not rely on unverified wheel dispatch. If target resolution cannot isolate the region, return unsupported/uncertain rather than silently scrolling the page. Do not change focus.
- [ ] Implement semantic single-option selection for supported controls; verify label and observe dependent field updates without an extra Enter. No automatic multi-step custom-dropdown algorithm inside `select_option`.
- [ ] Run tests/typecheck. Verify the parent viewport remains unchanged when a nested target is already at its boundary.

**Acceptance:** Optional scroll target semantics are preserved and custom widgets remain explicitly operable through visual primitives rather than false native-selection support.

### Task 8: Implement deterministic `check_ui` and bounded `wait_for`

**Files:** Create `src/adapters/browser/conditions.ts`, `src/tools/{check-ui,wait-for}.ts`; test `tests/unit/condition-semantics.test.ts`, `tests/browser/conditions.test.ts`.

**Interfaces:** Produces shared `evaluateCondition`; `check_ui` calls once, `wait_for` polls under the configured deadline.

- [ ] Write truth-table tests: absence -> hidden/pass, visible/fail, enabled/text/value/unknown; ambiguity -> unknown; invalidated observation -> unknown. Verify unsupported conditions cannot become inferred success.
- [ ] Write `check_is_single_evaluation` and `wait_rechecks_without_model_calls`. Assert delayed enablement can satisfy wait but a one-shot check fails at the earlier instant.
- [ ] Run `npm run test:unit -- condition-semantics` and `npm run test:browser -- conditions`; verify failures.
- [ ] Implement one-shot live reads without Playwright auto-retrying assertions. Normalize comparison exactly as the spec describes. Implement wait polling using a monotonic deadline and bounded per-read time.
- [ ] Add tests for same-document dynamic text, unknown interim values, document/frame replacement during polling, condition timeout, and unexpected dialog. Replacement produces invalidated, not hidden/pass against a stale document.
- [ ] Run tests/typecheck. Assert a wait performs no mutations and tool results contain the final fresh observation when available.

**Acceptance:** Check versus wait semantics remain distinct; model reasoning is never called inside either tool.

### Task 9: Implement `extract_data` and exposure-safe results

**Files:** Create `src/adapters/browser/extraction.ts`, `src/tools/extract-data.ts`; extend `runtime/evidence.ts`; test `tests/unit/conversion.test.ts`, `tests/browser/extraction.test.ts`, `tests/unit/redaction.test.ts`.

**Interfaces:** Implements `readProperty` and `extract_data`; uses the existing data-policy/evidence hooks.

- [ ] Write tests for named text/value/name fields, mixed successful and failed fields, all-field failure, missing/ambiguous targets, replacement during extraction, and duplicate field names. A batch crossing document generations must not report coherent completed extraction.
- [ ] Test plain finite decimal conversion and rejection of empty/currency/grouped/NaN/Infinity strings; verify a currency display is preserved when output type is string. Test keys such as `__proto__` cannot mutate output object behavior.
- [ ] Run `npm run test:unit -- conversion redaction` and `npm run test:browser -- extraction`; verify failures.
- [ ] Implement data reads and strict conversion with per-field errors. Preserve explicit output policy failures and partial results; do not fabricate absent fields or infer currency/locale semantics.
- [ ] Inject synthetic sensitive markers into text inputs, dialog messages, URL queries and fixture images; assert prohibited values never reach model payloads, structured logs or saved evidence. Suppress screenshots when safe redaction cannot be established; never save raw traces by default.
- [ ] Run tests/typecheck and inspect only synthetic permitted output.

**Acceptance:** Readable values return in declared shapes with honest partial/unknown outcomes, and exposure policy precedes transport/persistence.

### Task 10: Add intervention requests and provisional finalization

**Files:** Create `src/runtime/{intervention,finalization}.ts`, `src/tools/{request-human,finish-task}.ts`; test `tests/unit/intervention.test.ts`, `tests/unit/finalization.test.ts`.

**Interfaces:** Produces `InterventionPort.request(InterventionRequest) -> InterventionReceipt` and `FinalizationPort.finalize(FinishTaskInput, TrustedRunContext) -> FinishTaskResult`. Trusted context is constructed by runtime, not supplied by the model.

- [ ] Write tests that an LLM `request_human` and a runtime dialog/dead-end policy both reach the same port with trusted run/session context; neither permits further autonomous mutations after acceptance. Test duplicate events do not create uncontrolled repeated requests.
- [ ] Write a finalization test that a claimed `goal_achieved` with no configured artifact persistence returns `ARTIFACT_INTEGRATION_REQUIRED`, not accepted. Test declared output mismatch, unknown business code and unsupported success evidence rejection.
- [ ] Run `npm run test:unit -- intervention finalization`; verify failures.
- [ ] Implement minimal request creation/reporting and a runtime execution gate. Do not implement operator routing, takeover UI, control ownership transfers after request, or resume semantics in this task.
- [ ] Implement replaceable draft finalization delegation. Default successful-discovery acceptance is unavailable until the artifact layer supplies its validated persistence integration. Do not save raw tool-call lists as pretend capability artifacts.
- [ ] Run tests/typecheck. Preserve browser session state on intervention and expose structured pending state to the caller.

**Acceptance:** Both intervention sources work; no artifact-dependent success is fabricated. The deferred integration is visible and testable.

### Task 11: Wire tool dispatch into a bounded discovery-loop port

**Files:** Create `src/agent/{model-port,discovery-loop}.ts`; complete `tools/registry.ts`; test `tests/unit/discovery-loop.test.ts` and `tests/unit/model-payload.test.ts`.

**Interfaces:** Produces `runDiscovery({ goal, targetUrl }, session, model: ModelPort) -> RunResult`. `ModelPort.next` accepts goal/history/tool definitions plus permitted observation text/images and returns tool proposals or messages. `RunResult` distinguishes awaiting intervention, limit reached, failed, awaiting artifact integration, and finalized outcome.

- [ ] Write a fake-model transcript that observes, types, clicks, checks/extracts, and proposes completion. Assert every action passes through dispatch and the bound adapter; model text saying "done" is not accepted completion.
- [ ] Write tests for unknown/malformed tools, repeated unchanged observations, call/time exhaustion, multiple proposed calls with stale observation dependencies, missing image bytes, and tool output accidentally containing private bindings.
- [ ] Run `npm run test:unit -- discovery-loop model-payload`; verify failures.
- [ ] Implement serial proposal handling, history/results with matching call IDs, actual multimodal image forwarding, configured budgets, runtime intervention triggers, and no hidden model calls inside checks/replay-like behavior.
- [ ] Reject or return stale-reference errors for later proposed actions that depend on a superseded observation; do not execute a whole speculative batch against old state. Count explicit model tool calls and internal elapsed time; automatic post-action captures are not new model calls.
- [ ] Run tests/typecheck. Clearly label fake-model logs as scripted tests. Leave provider credentials/model/API adapter selection for a later integration decision.

**Acceptance:** The loop integration is ready for a real provider, but no genuine discovery evidence or complete-assignment claim is made yet.

### Task 12: Demonstrate the foundation in a visible browser and document limits

**Files:** Create `src/demo/scripted-run.ts`, `docs/computer-use-development.md`; extend `package.json` scripts and fixture app; test `tests/browser/foundation-flow.test.ts`.

**Interfaces:** Uses `createSession` and `dispatchTool` exclusively. Provides a development harness with explicit goal/target inputs, public results/events, and graceful browser cleanup; the later UI can consume the same runtime entry points.

- [ ] Write a real-browser flow test covering semantic member search, a custom visual widget, extraction/checkpoint, native dialog policy, stale refs, and an intervention request. Include two independent sessions to verify context/reference isolation. Add a run with semantic capture disabled that operates the visual widget through points; do not require unsupported deterministic checks/extraction to succeed in that mode.
- [ ] Run `npm run test:browser -- foundation-flow`; diagnose genuine missing behavior rather than reducing assertions to method-call counts.
- [ ] Implement `npm run demo:computer-use` for a headed, visibly paced scripted run against the allocated fixture URL. It must identify itself as a scripted mechanics demo and stop honestly at intervention or artifact-dependent finalization boundaries.
- [ ] Run `npm run typecheck`, `npm run test:unit`, and `npm run test:browser`. Once these pass, run the single headed smoke demonstration only during authorized implementation, not during plan review.
- [ ] Document exact setup/test/demo commands, browser visibility, the synthetic fixture URL mechanism, configured defaults, all 12 tool contracts, known limitations, and the remaining assignment layers. Explain that source isolation and a desktop-capable interface do not prove desktop support or production scale.
- [ ] Review changed files/evidence scope. If Git has been established and commits are authorized, create a scoped checkpoint; do not push or publish as part of this plan.

**Acceptance:** A reviewer can observe real browser actions performed through the agreed tool/runtime/adapter boundaries and can see exactly what remains unimplemented.

## 5. Coverage matrix

| Agreed item | Owning task | Evidence |
| --- | --- | --- |
| All typed inputs/results | 1 | Runtime schema/JSON round-trip tests |
| Startup adapter binding, no LLM adapter argument | 2 | Constructor count and schema tests |
| Per-session isolation | 2, 12 | Cross-session rejection and two-context test |
| Observer modes and actual image transport | 3, 11 | Capture and model payload tests |
| Observation/control maps and invalidation | 2, 3, 5 | Replacement, iframe and collision tests |
| `navigate` | 5 | Readiness, redirect, blocked and timeout cases |
| `click` | 5 | Semantic/point paths, overlays and stale refs |
| `type_text` | 6 | Replace/append/focus/uncertain verification |
| `press_key` | 6 | Optional semantic target, no hidden click |
| `scroll` | 7 | Optional targets, fractions, boundaries, movement |
| `select_option` | 7 | Exact unique option and explicit custom fallback |
| `wait_for` | 8 | Polling deadline and invalidation |
| `check_ui` | 8 | One-shot truth table, no point target |
| `extract_data` | 9 | Control-only reads, partial outputs and conversion |
| `request_human`, both sources | 10 | Shared intervention port and execution stop |
| `finish_task` provisional/artifact dependency | 10 | No acceptance without artifact integration |
| Runtime-owned policy and dialogs | 4, 5 | Unknown escalation, pending action exclusion |
| Data exposure and evidence | 3, 9, 11 | Synthetic marker exclusion |
| Bounded LLM-loop integration | 11 | Scripted ModelPort tests; real provider deferred |
| Visible browser demonstration | 12 | Headed scripted harness |
| Future application interface | 11, 12 | Stable consumer-facing runtime API; UI deferred |
| Future desktop adapter | 2 | Browser-independent port; no desktop support claim |

## 6. Execution ordering and release gates

Execute Tasks 1-4 first; they establish contracts, reference validity and policy. Tasks 5-9 depend on those interfaces and should be reviewed against the shared status meanings. Tasks 10-12 integrate the tools without filling deferred scope with fake implementations.

Recommended execution method: native sequential implementation initially, because all tool handlers share the same session/reference/dispatch contracts. Independent review can follow coherent milestones once an execution method is chosen. No agent delegation is required to create or review this plan.

Before calling this foundation complete, require all listed tests, the visible scripted mechanics run, and accurate documentation. Before calling the **assignment** complete, separately require artifact design/replay, a genuine model-driven run, full human handoff, and the requested product interface/deliverables.

## 7. Plan self-review

- Every agreed tool has a contract, owner, implementation task and behavioral verification.
- Later user refinements supersede earlier suggestions: no point `press_key`; no point check/extract; runtime dialog policy; post-intervention flow deferred; successful finalization depends on artifacts.
- Proposed language/libraries/default limits are labeled, not presented as previously approved choices.
- No artifact schema, replay algorithm, operator console, or UI framework is silently chosen.
- Public identifiers and internal interface names match the companion design; Playwright objects remain adapter-private.
- The five Review Focus risks each have owning tasks and explicit tests.
- Source references are in the companion design; exact package APIs must be validated against pinned versions at implementation time.
- This plan has not been executed. No implementation, dependency installation, browser run, model run, commit, push, or deployment is implied.
