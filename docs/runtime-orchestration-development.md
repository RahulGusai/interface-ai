# Runtime orchestration development

This document covers the standalone browser runtime and its original verification record. The current FastAPI/backend setup is documented in the repository README. Runtime policy evaluation was removed on 2026-10-07; output contracts and tool execution validation remain.

## Setup and verification

Use Node 22.19+ LTS (Node 24 LTS is also supported). The implementation was exercised with Node 22.19.0 and Playwright 1.58.2 Chromium. Dependencies are pinned in `package.json` and `package-lock.json`.

```sh
npm ci --legacy-peer-deps
npx playwright install chromium
npm run typecheck
npm run test:unit
npm run test:browser
npm run test:integration
npm test
npm run format:check
```

The test fixture binds `127.0.0.1` on an OS-allocated port, closes during teardown, and contains synthetic data only. Browser tests require permission to launch Chromium and bind loopback. The browser adapter uses the Playwright library, not Playwright Test. No screenshot, raw provider response, or browser trace is saved to disk.

`test:unit` uses fake transports/adapters/models. `test:browser` uses real Chromium without an LLM. The normal integration test uses a scripted fake model with real Chromium. These are separate from the explicitly gated, paid live test.

## Headed mechanics demo

```sh
npm run demo:computer-use
```

This opens a visible Chromium window, starts an allocated synthetic fixture, types member 42, clicks Search, extracts the displayed member, and proposes completion. It prints `SCRIPTED mechanics demo` and returns `awaiting_artifact_design`. It is not LLM evidence.

## OpenRouter configuration and live entry point

Set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in your shell. `.env.example` contains names only; the runtime does not automatically read `.env`. The model must be an explicit compatible slug supporting image inputs and client-side function calls. There is no default model, alternative provider, fallback model or automatic retry. Model compatibility is not inferred from its name.

```sh
npm run demo:runtime -- --goal 'Find synthetic member 42' --synthetic
npm run demo:runtime -- --goal 'Inspect this page' --url 'https://example.org/app'
```

Both commands make all supported browser tools and screenshots available. There are no action, destination, resource, dialog or exposure policy callbacks or command-line switches. Redirects, cross-origin frames and resources, WebSockets, service workers and browser downloads are available; native dialogs are accepted automatically. The backend always supplies the registered app deployment's URL as the discovery starting URL.

The CLI is headed by default. `--headless` is for automation. `--max-tool-calls 12` changes the positive integer budget (default 40). `--synthetic` starts the member-search fixture and supplies its output contract. Other task output contracts are supplied through the library API.

```sh
RUN_LIVE_OPENROUTER=1 npm run test:integration
```

The paid smoke test runs only when that flag and both environment variables are present. It starts its own synthetic fixture and draws a random code in a canvas. The code is absent from semantic control metadata and the user instruction. A passing test requires actual screenshot forwarding, a genuine model-issued `type_text` with the correct code, completed browser input, and provisional finalization. This establishes image-plus-tool compatibility for that configured model in that test; it does not establish general reliability or complete discovery/replay.

**Live verification status:** not performed in this implementation environment because `OPENROUTER_MODEL` was unset. No key or configured model slug is printed. The plan asks both for slug recording and non-disclosure in results; non-disclosure takes precedence here. Keep any reproducibility record of the configured slug privately. Public `RunResult.model` is `configured-model`.

## Public runtime boundary

`runTask(input, { model, adapterFactory, contract }, options)` validates input and creates one browser adapter for that invocation. Every tool, including initial navigation, uses the same bound adapter. The runtime owns history, dispatch and counting. The adapter owns references and browser operations. There is no session ID, persistent registry, resume, cross-run browser reuse, or LLM-selected adapter.

The optional task contract validates declared outputs and business outcome codes. It does not evaluate whether browser actions or destinations are permitted. Tool argument/result schemas, screenshot correlation, current observations and reference validity still validate execution.

The provider always receives all twelve generated tool schemas, ordered assistant calls and matching tool results. Tool-call IDs are preserved. Tool images are carried as actual in-memory PNG data URLs, paired with observation and call IDs. Image messages are emitted after an entire tool-result batch, preserving the provider's tool protocol. Missing bytes fail before a provider request. UI content is marked as untrusted data in the fixed versioned prompt and observation messages.

Every processed model proposal counts, including malformed/unknown/blocked calls and `finish_task`. Bootstrap navigation, automatic post-action captures and internal condition polling do not count. A batch larger than the remaining budget executes **none** and consumes no slots. Calls within budget execute sequentially. A terminal call stops the run, so later unexecuted proposals in that batch receive no fabricated result and no later provider request occurs. Last-slot finalization is handled before the next-turn budget stop.

An optional `onAudit` sink receives proposals, exact argument strings and parsed inputs, dispatch starts, full results with permitted images, unexecuted proposals and the terminal result. Unlike diagnostic `onEvent`, audit errors halt the run. `createFileAudit` writes numbered timestamped JSONL and screenshot files, synchronizing each record before execution proceeds. The [Meridian runner](meridian-local-test.md) uses this sink for local test evidence; it does not implement production capability artifacts or replay.

The only agent stopping budget is `maxToolCalls`. Individual HTTP, navigation, input and wait operations have finite timeouts. Defaults: 1280×800 viewport, scale factor 1, navigation 15 seconds, action/capture/wait 5 seconds, condition poll 100 ms. There is no task timer, no-progress heuristic, model-token budget or compression.

## Tools and results

| Tool | Inputs and restrictions | Result meaning |
| --- | --- | --- |
| `observe_ui` | Required `mode`: screenshot, controls, both | Current metadata plus actual permitted PNG bytes; unavailable differs from empty |
| `navigate` | URL; bootstrap comes from the registered deployment in the backend | Navigation/observation completed, blocked, failed or uncertain; not business success |
| `click` | Observation + control or screenshot point | One primary click; no forced click or automatic retry |
| `type_text` | Observation + control/point, text, replace/append | Completed only with matched text; append is at field end |
| `press_key` | Observation, optional control, single key/chord | Focus without click; point target prohibited; modifiers released |
| `scroll` | Observation, optional control/point, direction, positive distance ≤2 | Visible region fraction, isolated boundary, measured movement |
| `select_option` | Observation + control + exact observed label | Native single-select only; unique enabled option; custom widget unsupported |
| `wait_for` | Observation + control + deterministic condition | Polls until met, deadline, invalidation or block; no hidden model calls |
| `check_ui` | Same condition input | One read; pass/fail/unknown are distinct |
| `extract_data` | Unique named control fields; text/value/name; string/number | Completed/partial/failed with individual errors; strict finite decimals |
| `request_human` | Observation, enumerated reason, message | Stops autonomous execution and returns a request ID; no operator routing |
| `finish_task` | Draft observation/outcome/summary and optional declared outputs/code | Goal achieved remains awaiting artifact design; other outcomes validated against trusted contract |

Conditions are visible, hidden, enabled, text_equals and value_equals. Text comparison normalizes line endings only. Missing observed elements satisfy hidden, fail visible, and are unknown for other properties. Replaced documents/frames invalidate references rather than proving absence. Exact captured element handles distinguish duplicate labels privately. Native select option labels are published as option controls linked by parent_ref. Password value conditions return unknown without value evidence. Controls expose no selectors or Playwright objects.

New observations supersede all prior references. Navigation/frame replacement invalidates bindings; action targets are revalidated. Points refer to the exact viewport screenshot in CSS pixels, including at device scale 2. Detectable layout drift in the main document or child frames rejects point actions. Point typing must match the hit-tested editable focus and cannot reuse an unrelated previously focused field. The complete capture (including semantic reads) has a finite deadline and halts pending work on timeout. Capture retries once if the document/layout changes; it does not claim atomicity on a continuously changing UI. Unsupported cross-origin editable focus or custom widgets fail honestly. There is no unrestricted JavaScript or selector tool.

Native dialogs are accepted automatically. Failed dialog handling and unsupported additional pages still report execution limitations. Task cleanup closes the context to terminate unresolved operations; takeover is not implemented.

## Outcomes and remaining scope

Public statuses: `max_tool_calls_reached`, `needs_intervention`, `awaiting_artifact_design`, `business_outcome`, `unable_to_complete`, `agent_stopped_unverified`, `provider_error`, `tool_error`. Historical persisted records may still contain `policy_blocked`; the runtime no longer evaluates policies or emits that outcome. Model text saying “done” is only an unverified report.

Still deferred: validated capability artifacts and storage/versioning, deterministic replay, full human takeover/resume/action capture, product UI and artifact manager, desktop adapters, additional providers/fallbacks, distributed/concurrent execution, persistent evidence/checkpoints, history compression, additional task budgets, risky-action approval continuation, and final `finish_task` schema. Source organization is not proof of desktop support or production scale. No deployment, publication, push or complete-assignment claim is made.

Implementation rulings and test evidence are in `docs/implementation-progress.md`.

API reference checks used during implementation: [OpenRouter client tool calls](https://openrouter.ai/docs/guides/features/tool-calling), [OpenRouter image input](https://openrouter.ai/blog/tutorials/send-image-to-llm/), [Playwright dialogs](https://playwright.dev/docs/dialogs), and [Playwright exact element handles](https://playwright.dev/docs/api/class-elementhandle).

## Verification record

Final implementation check: 51 tests passed, 1 paid live test skipped; typecheck and formatting passed. The final headed scripted demo completed four tool proposals and returned awaiting_artifact_design. An independent read-only review preceded the safety regression fix pass; final fixes were verified by tests. Detailed evidence and rulings are recorded in the implementation ledger.
