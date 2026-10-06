# Runtime Orchestration and Policy Implementation Plan

> **For agentic workers:** Use this plan task by task. Checkbox steps track implementation. This plan replaces the orchestration and session assumptions in the earlier computer-use foundation plan; its action contracts and browser adapter tasks remain the source for tool implementations.

**Goal:** Build the first runtime slice: an OpenRouter-driven discovery loop that prepares context, manages conversation history, validates and dispatches typed tool calls through one browser adapter per task, applies runtime policy, and stops after a maximum number of model-requested tool calls.

**Architecture:** Each invocation owns an in-memory `TaskRunContext` containing its browser adapter, conversation, policy, and tool-call count. The adapter is created once at task start and all tools use that bound instance. A single OpenRouter client translates between internal messages and Chat Completions; the runtime owns every tool execution and final outcome classification.

**Tech Stack:** Existing agreed browser choice: Playwright/Chromium. Proposed for implementation: TypeScript, supported Node.js LTS, npm, Zod for schemas, Vitest for tests, and native `fetch` for the OpenRouter Chat Completions API. Exact package versions are pinned during implementation.

**Spec:** Current user decisions in this conversation, [computer-use tool design](../specs/2026-10-05-computer-use-design.md), and [tool/browser implementation plan](./2026-10-05-computer-use-implementation.md). **Precedence:** this plan wins for task-scoped runtime, provider integration, and stopping behavior. The earlier files win for each individual tool's inputs, outputs, and browser action behavior, except their session fields become private task-context fields. The earlier plan's Tasks 2, 4, 10, and 11 require this new design rather than literal execution.

## Global Constraints

- No persistent session concept, session registry, session ID, or session-selection argument. One invocation creates one task-local browser adapter and uses it until that invocation ends.
- OpenRouter is the only LLM provider in this phase. Read `OPENROUTER_API_KEY` and exact model slug `OPENROUTER_MODEL` from environment; require both for a live run, disclose neither in logs/results. No default or automatic model fallback.
- The selected model must support both image input and client-side function/tool calling for the hybrid demo; live compatibility must be established before claiming a working demo.
- Use the previously agreed 12 tool contracts. Implement action mechanics from the tool/browser plan. This plan creates orchestration, typed dispatch, and policy; it does not redefine tool behavior.
- The only agent-level stopping budget is `maxToolCalls`. Provider, schema, policy, and browser failures may terminate with explicit error outcomes; they are not additional progress budgets.
- Count every model-requested tool call, including invalid/blocked calls and `finish_task`. Internal initial navigation/observation and automatic post-action observations do not count.
- Tool execution is sequential, even if a model returns multiple tool calls. Request `parallel_tool_calls: false` where supported, but do not assume a model obeys it.
- No live browser, OpenRouter request, service, or localhost preview is started while writing or reviewing this plan.

## Explicitly deferred runtime functionality

| Deferred responsibility | Boundary in this slice |
| --- | --- |
| Persistent session management | Browser adapter belongs to one task invocation; no resume, task registry, or cross-run browser reuse. |
| Artifact recording/compilation/storage/versioning | No successful discovery artifact is created. `finish_task` success is provisional and cannot be accepted as completed capability. |
| Deterministic replay | No executor for saved actions or parameterized invocation. |
| Full human intervention flow | Runtime and LLM can emit `request_human`/`needs_intervention`; operator routing, live takeover, recording human actions, and resume remain future work. |
| User-facing application interface | A thin CLI/test harness may run the task; goal/URL form, progress UI, browser embedding, and artifact manager are future work. |
| Desktop and other surface adapters | Browser adapter only; typed tool contracts retain the future seam. |
| Additional LLM providers and model fallback | One OpenRouter client and one configured model slug. OpenRouter's own internal route selection is outside our adapter; no application-level fallback. |
| More agent stopping budgets | No overall task timer, no no-progress detector, no model-token or cost budget, no separate max-step limit. Individual HTTP/browser operations still fail or time out safely. |
| History compression and durable checkpoints | Full bounded in-memory transcript for this short demo; no resume after process exit and no automated summarization. |
| Concurrent actions and distributed execution | One tool action at a time per task; no queues, workers, or multi-tenant scheduler. |
| Persistent audit/evidence package | Minimal structured progress/result events and sanitized test diagnostics only; final `/evidence/` assignment deliverables follow the real run and artifact design. |
| Risky-action approval workflow | Policy may deny or request intervention; the later human approval/continuation mechanism is not implemented. |
| Final `finish_task` schema | Keep a draft input/result boundary until capability artifact and output schemas are finalized. |

## Review Focus

1. Multiple tool calls returned when only one budget slot remains: execute none and stop `max_tool_calls_reached`, without an unmatched tool result in a later request (Task 4).
2. Malformed or unknown tool arguments: count the requested call, return a structured tool error, and never invoke the browser adapter (Tasks 2, 3, 4).
3. The provider receives an image reference without actual image bytes: fail the projection before the request; send permitted screenshot bytes as an image part (Tasks 2, 5).
4. A model reply says “done” without a verified `finish_task` outcome: return `agent_stopped_unverified`, not success (Tasks 1, 4).
5. A blocked action or unsafe dialog is still pending in Playwright: no concurrent follow-up input; surface the block or intervention request (Tasks 3, 6).

## 1. File map

Create or modify these paths when implementation begins. The repository currently contains only the two planning documents; the source files below do not exist yet.

```text
package.json
package-lock.json
tsconfig.json
vitest.config.ts
.env.example                    names only, never credentials
.gitignore                      ignore .env, generated screenshots and raw traces
src/contracts/
  observation.ts                reuse observation schema from tool plan
  tools.ts                      reuse typed action schemas from tool plan
  finish-task.draft.ts           reuse provisional finalization schema
  errors.ts                     reuse public error/dialog metadata
  run.ts                        TaskInput, AgentTurn, RunEvent, RunResult schemas
src/runtime/
  config.ts                     env validation and trusted maxToolCalls option
  prompts.ts                    fixed/versioned system prompt and initial user context
  history.ts                    ordered internal conversation and provider projection
  policy.ts                     URL, action, dialog and data-exposure decisions
  dispatch.ts                   typed validation/policy/executor bridge
  run-task.ts                   agent loop and task-local browser binding
src/llm/
  model-client.ts               provider-neutral interface internal to this phase
  openrouter-client.ts          only concrete provider; non-streaming HTTP adapter
src/tools/
  registry.ts                   12 tool schemas, descriptions and action delegates
src/demo/
  run-task-cli.ts               optional thin demo entry point, no web UI
tests/unit/
  config.test.ts
  prompts.test.ts
  history.test.ts
  tool-dispatcher.test.ts
  policy.test.ts
  run-task.test.ts
  openrouter-client.test.ts
tests/integration/
  live-openrouter.test.ts       explicit opt-in; no credential required in normal test suite
```

The browser/action implementation plan owns `src/adapters/browser/*`, individual `src/tools/<action>.ts` handlers, the observation-reference store, and Playwright fixtures. Avoid duplicating those modules here. If implementation order puts this plan first, use a fake adapter/tool executor for all tests and wire the real implementation when available.

## 2. Public orchestration contracts

Use a runtime schema for every external entry and result. Tool-specific schemas come from the existing tool plan. The following names and properties are implementation decisions for this plan:

```typescript
type TaskInput = {
  goal: string;                    // Trimmed, non-empty
  targetUrl: string;               // Absolute HTTP(S), validated against trusted policy
};

type RunStatus =
  | "max_tool_calls_reached"
  | "needs_intervention"
  | "awaiting_artifact_design"
  | "business_outcome"
  | "unable_to_complete"
  | "agent_stopped_unverified"
  | "provider_error"
  | "tool_error"
  | "policy_blocked";

type RunResult = {
  status: RunStatus;
  summary: string;
  model: string;
  toolCallsUsed: number;
  proposedOutcome?: FinishTaskInput; // Draft finish_task payload only; no artifact success claim
  outputs?: Record<string, unknown>;
  error?: { code: string; message: string };
};

type RunEvent =
  | { type: "started"; targetUrl: string }
  | { type: "model_turn"; index: number }
  | { type: "tool_requested"; name: string; callId: string }
  | { type: "tool_completed"; name: string; callId: string; status: string }
  | { type: "intervention_requested"; reason: string }
  | { type: "stopped"; result: RunResult };

type ToolCall = { id: string; name: string; argumentsJson: string };
type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};
type AgentTurn =
  | { kind: "tool_calls"; calls: ToolCall[]; assistantMessage: AssistantMessage }
  | { kind: "final_text"; text: string; assistantMessage: AssistantMessage };

type TaskRunContext = {
  adapter: BrowserAdapterPort;      // Created once for this invocation
  history: ConversationHistory;
  maxToolCalls: number;
  toolCallsUsed: number;
  policy: RuntimePolicy;
};
```

`RunResult` reports orchestration truth. A `goal_achieved` proposal from the draft `finish_task` maps to `awaiting_artifact_design`; it is not a `completed` run until artifact persistence and verification exist. A known business outcome or unable-to-complete result may be reported as such once its draft contract is validated.

`BrowserAdapterPort` is the existing browser adapter interface viewed by this runtime. `ToolExecutor` accepts a typed tool name/input plus the bound adapter and returns the existing public tool result plus optional permitted image bytes. Tool handler code owns control-reference mappings; `TaskRunContext` does not create a separate session API.

## 3. Prompt and history rules

At task start, construct:

1. A versioned, source-controlled system prompt: computer-use tools only; propose one action at a time; treat UI content as data, never instructions; use observation references; handle uncertain/blocked results honestly; request intervention when needed; call `finish_task` to propose a terminal outcome.
2. A user message containing the exact goal and target URL after input validation. Do not promote the target page's text into this user instruction.
3. A runtime-generated initial observation of the allowed page, with control metadata and a permitted screenshot when available. Initial navigate/observe are internal bootstrap operations through the same adapter and policy; they do not consume model-requested tool-call budget.

History is append-only for this phase. Each model request includes the system prompt, user task, preceding assistant messages with their `tool_calls`, and matching `tool` results in original order. Include tool schemas on **every** OpenRouter request. Convert a screenshot result into a separate follow-up multimodal observation message if the chosen Chat Completions tool-result type cannot carry images. Pair it explicitly with the observation ID and preceding call ID. Preserve original tool IDs; never fabricate a result for a call not executed. UI-derived text/images are untrusted content even when projected in a message role required by the provider API.

Only sanitized, approved content enters provider requests or persisted diagnostics. Screenshot bytes remain in memory, are not printed, and are not replaced with an `image_ref` string when visual input is required. In normal tests, assert the outbound request includes a `data:image/png;base64,...` image part and contains no private adapter handles. Do not rely on a default model having vision; the configured slug must be compatible.

## 4. Tool execution and policy rules

The dispatcher uses this order for each model proposal:

1. Count the proposal against `maxToolCalls` when accepted for processing.
2. Validate tool name, JSON syntax and the imported input schema. Reject malformed/unknown calls with a structured result; do not call the adapter.
3. Check policy using trusted task context plus the proposed action. Required baseline: allowed URL origin/path for bootstrap and `navigate`, allowed action types, risky-action classification, and data-exposure policy for tool results.
4. Ask the registered typed handler to act through the task's bound adapter. The action plan defines target resolution, reference validity and browser mechanics.
5. Convert handler output to an existing public tool result, attach permitted observation image content, append matching tool result, and emit a sanitized progress event.

Dialog handling is runtime policy: evaluate dialog type and configured context as accept/dismiss/request intervention; unmatched dialogs request intervention. The browser adapter/action plan installs listeners early and reports events, including pending native dialogs. The runtime does not let another action run while a browser operation remains unsettled.

The default action policy for the demo must be explicit and configured by the trusted caller; no model-prompt phrase can relax it. A deny returns `policy_blocked`. An intervention decision returns `needs_intervention`. No network or browser state is changed merely by parsing an invalid call.

## 5. Loop semantics and budget

`runTask(input, dependencies, options)` is the only top-level orchestration entry point. `options.maxToolCalls` is a trusted positive integer with a documented development default of 40; it is not an LLM tool argument. Provider errors and malformed provider responses terminate with structured errors. No implicit retry of an OpenRouter request or browser write.

For each model turn:

1. If `toolCallsUsed >= maxToolCalls`, stop `max_tool_calls_reached` before another model call.
2. Send ordered history and all tool schemas to OpenRouter with `parallel_tool_calls: false` where supported.
3. Parse exactly one provider reply. If it contains `tool_calls`, require unique IDs. If the batch size exceeds remaining budget, execute none and stop `max_tool_calls_reached`; do not append the unexecuted assistant batch to a future provider request.
4. Otherwise append the assistant tool-call message and process every proposal sequentially. Invalid/blocked calls still consume slots and receive matching structured tool results. A call that returns intervention or a terminal outcome stops after history/result recording.
5. After all tool results, continue to the next model turn. If the provider emits final text without an accepted `finish_task`, stop `agent_stopped_unverified` and preserve the text as a report, never proof of success.

If the last allowed tool is `finish_task`, process its result before applying the next-turn limit. If the last tool call was non-terminal, stop at the budget. Automatic observations after actions are not counted as model tool calls.

## 6. OpenRouter adapter

Use OpenRouter's Chat Completions endpoint over `fetch`, non-streaming initially. The provider client reads `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` at startup and returns an `AgentTurn`; no other provider adapter is included. Include the exact model on every request, pass client-side function definitions on every request, and preserve assistant `tool_calls` plus `tool_call_id` matched results in subsequent history. Use JSON body validation on responses; empty choices, malformed arguments, duplicate/missing call IDs and unsupported model errors become clear provider/protocol errors.

If a screenshot is permitted, send a local in-memory data URL image part rather than exposing a localhost or private URL. Use an explicit model slug instead of an automatically changing alias for reproducible evidence. The runtime must not log API keys, authorization headers, base64 screenshots, full sensitive prompts, or raw provider responses. An opt-in live smoke test verifies the configured model can process one screenshot and issue a tool call; do not claim compatibility from a model name alone.

OpenRouter source checks made for this plan: [Quickstart and endpoint](https://openrouter.ai/docs/quickstart), [client tool-call protocol](https://openrouter.ai/docs/guides/features/tool-calling), [Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion), [image input example](https://openrouter.ai/blog/tutorials/send-image-to-llm/). Recheck against the current API and selected model before implementation.

## 7. Implementation tasks

### Task 1: Create run schemas and fixed context builder

**Files:** Create `src/contracts/run.ts`, `src/runtime/{config,prompts}.ts`, `.env.example`; tests `tests/unit/{config,prompts}.test.ts`.

**Interfaces:** `parseTaskInput(raw): TaskInput`, `loadOpenRouterConfig(env): { apiKey, model }`, `buildInitialMessages(input, promptVersion): InternalMessage[]`, `RunResult`, `RunEvent`.

- [ ] Write failing tests for empty goal, invalid/non-HTTP(S) URL, missing environment variables, positive finite `maxToolCalls`, and initial message ordering: system prompt before exact goal/URL before initial observation.
- [ ] Run `npm run test:unit -- config prompts` and confirm failures from absent schemas/functions.
- [ ] Implement the schemas and versioned system-prompt template. Avoid putting API credentials in `RunResult`, events or exception messages.
- [ ] Run the targeted tests and `npm run typecheck`; require pass.

### Task 2: Implement typed OpenRouter request/response transport

**Files:** Create `src/llm/{model-client,openrouter-client}.ts`; tests `tests/unit/openrouter-client.test.ts`.

**Interfaces:** `ModelClient.complete(messages, tools): Promise<AgentTurn>`; `OpenRouterClient` implements `ModelClient` using injected `fetch` for tests.

- [ ] Test a tool-call response, a final-text response, malformed/empty choices, duplicate/missing tool IDs, HTTP/auth error, missing image bytes and a text-plus-PNG image request. Use a fake HTTP transport; do not call a paid API in unit tests.
- [ ] Run `npm run test:unit -- openrouter-client` and confirm failures.
- [ ] Implement non-streaming Chat Completions request/response mapping, `OPENROUTER_MODEL`, client tool schemas on each request, and safe error normalization. Preserve provider tool-call IDs exactly.
- [ ] Run targeted tests/typecheck. Inspect captured fake requests for image parts and absence of the API key in returned/logged objects.

### Task 3: Build the tool registry and runtime policy dispatcher

**Files:** Reuse `src/tools/registry.ts` and `src/runtime/policy.ts` from the action plan; create/extend `src/runtime/dispatch.ts`; tests `tests/unit/{policy,tool-dispatcher}.test.ts`.

**Interfaces:** `ToolRegistry.definition(name)`, `ToolRegistry.parse(name, args)`, `dispatchTool(context, proposal): Promise<ToolDispatchResult>`; a `ToolExecutor` interface delegates valid calls to the earlier tool/action implementation using the same adapter.

- [ ] Write failing tests for all 12 registry entries, wrong target kinds, unknown/malformed tools, forbidden destinations/action types, risky-action intervention, allowed action delegation, and redacted result projection. Assert a fake executor is never called for rejected input.
- [ ] Run `npm run test:unit -- policy tool-dispatcher` and confirm failures.
- [ ] Implement one parsing/authorization/dispatch path. Policy uses trusted task configuration; tool arguments may propose an operation but cannot change allowed origins/actions or dialog rules.
- [ ] Add policy tests for native dialog accept/dismiss/intervention and unmatched default intervention, plus an event from an action still pending: dispatcher blocks further action until settled.
- [ ] Run targeted tests/typecheck. Confirm tool/action behavior remains delegated to the existing implementation plan.

### Task 4: Implement conversation history and the bounded agent loop

**Files:** Create `src/runtime/{history,run-task}.ts`; tests `tests/unit/{history,run-task}.test.ts`.

**Interfaces:** `ConversationHistory.appendAssistantToolCalls`, `.appendToolResult`, `.appendObservationImage`, `.toOpenRouterMessages`; `runTask(input, deps, { maxToolCalls, onEvent? }): Promise<RunResult>`.

- [ ] Write fake-model tests for initial context, exact message ordering and tool IDs, multiple sequential calls, malformed call feedback, terminal `request_human`, draft `finish_task`, final text without finalization, last-slot `finish_task`, and the next-turn budget stop.
- [ ] Write boundary tests: two calls returned with one slot left execute none; two within budget execute sequentially; a stale second reference produces a tool error without bypassing the tool executor; every proposed tool call uses the same task-bound adapter.
- [ ] Run `npm run test:unit -- history run-task`; confirm failures.
- [ ] Implement append-only in-memory history, model/tool loop, batch budget preflight, trusted call counter and sanitized progress events. A fake `finish_task` proposing success returns `awaiting_artifact_design`; do not generate a pretend artifact.
- [ ] Run targeted tests/typecheck. Assert every result has a validated `RunStatus` and every executed provider tool call receives exactly one matching result.

### Task 5: Bind one browser adapter per task and transport observations

**Files:** Extend `src/runtime/run-task.ts`, `src/runtime/history.ts`; test `tests/unit/task-adapter.test.ts`, `tests/unit/image-history.test.ts`.

**Interfaces:** `BrowserAdapterFactory.createForTask(input, policy): Promise<BrowserAdapterPort>` and task-local `TaskRunContext`. The adapter/action plan supplies actual Playwright behavior.

- [ ] Test a factory invoked once per task, adapter used by every tool in that task, separate adapters for separate task invocations, and close on normal/error exits. No public session ID or registry appears in inputs/results.
- [ ] Test policy-checked initial navigation, initial screenshot delivery to the first model request, later screenshot after an action, missing-image failure, and private reference maps never serialized into history.
- [ ] Run `npm run test:unit -- task-adapter image-history` and confirm failures.
- [ ] Implement task-local adapter ownership and `try/finally` cleanup. Bind it before bootstrap navigation/observation; keep all tool calls on the same instance. Tool-level code manages `obs_017/c1` bindings privately within that invocation.
- [ ] Run targeted tests/typecheck. Keep the headful browser option in adapter configuration, not in LLM tool arguments.

### Task 6: Integrate browser actions and dialog events from the tool-level plan

**Files:** Update runtime bridge in `src/tools/registry.ts`/`src/runtime/dispatch.ts`; reuse browser/tool files from [the existing action plan](./2026-10-05-computer-use-implementation.md); tests `tests/integration/browser-dispatch.test.ts`.

**Interfaces:** The `ToolExecutor` adapter exposes the previously agreed 12 actions and returns typed results plus optional permitted observation image bytes. Event bridge provides dialog/navigation/pending-operation signals to policy.

- [ ] When tool-level browser actions exist, write a real-browser test: `observe_ui` -> control click/type -> point fallback -> `check_ui`/`extract_data`; assert one task-bound browser instance, exact tool schemas and result statuses.
- [ ] Add a dialog test where runtime policy accepts/dismisses a recognized dialog and requests intervention for an unknown one. Assert a pending Playwright operation prevents follow-up input until resolved/terminated.
- [ ] Run `npm run test:integration -- browser-dispatch`; confirm failing behavior before the bridge is implemented.
- [ ] Implement only the bridge needed to connect the existing action handlers to the runtime; do not duplicate Playwright action code. Map adapter signals to public tool results and stop/intervention statuses.
- [ ] Run integration tests/typecheck. A browser mechanics test is distinct from a real LLM run.

### Task 7: Add an opt-in live OpenRouter smoke path and developer instructions

**Files:** Create `src/demo/run-task-cli.ts`, `tests/integration/live-openrouter.test.ts`, `docs/runtime-orchestration-development.md`; update `package.json`, `.gitignore`.

**Interfaces:** `npm run demo:runtime -- --goal <text> --url <allowed-url>` and an explicit opt-in live test using `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`.

- [ ] Write a live test that is skipped unless an explicit opt-in flag is set, credentials are present, and the local synthetic browser fixture is running. It must verify one actual screenshot reaches the configured model and at least one real model-issued tool call is executed through the runtime.
- [ ] Add a CLI that prints sanitized progress/result events and opens the headed Playwright browser using the task-local adapter. The CLI must report `awaiting_artifact_design` if the model proposes successful completion, not claim a finished capability.
- [ ] Run `npm run typecheck`, all unit tests, and browser integration tests. Run the opt-in live test only with authorized credentials and record its model slug/outcome without logging tokens or screenshots.
- [ ] Document exact environment variable names, setup, supported model capabilities, max-tool-call semantics, public outcomes, and the deferred-runtime list above. State whether live verification was actually performed.

## Coverage and execution boundary

| Requested concern | Owning task |
| --- | --- |
| System prompt, user goal/URL, initial context | 1, 4, 5 |
| Typed actions, observations and agent outputs | 1, 3; tool schemas from earlier plan |
| Ordered conversation history and matched tool results | 2, 4 |
| OpenRouter only, model from environment | 1, 2, 7 |
| One browser adapter per task, no sessions | 5, 6 |
| Tool execution and runtime policy | 3, 6 |
| Only `maxToolCalls` stopping budget | 4 |
| Real model/browser integration proof | 7, after Task 6 |
| Explicit deferrals | Global Constraints and deferred table |

This plan is independently testable with fake model and fake action executor through Task 5. Tasks 6-7 depend on the action/browser implementation. The complete assignment remains pending artifact, replay, human control and product interface work.
