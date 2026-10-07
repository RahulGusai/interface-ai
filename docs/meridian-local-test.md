# Meridian local banking test

The first scenario finds Casimir Whitlock's Savings account ending 4413 at Harbor Street and reports January 2026 debit count, total and largest debit. All banking data is synthetic. The local copy in `sandboxes/meridian` comes from Lovable project `23654c50-2a16-49e7-af7d-2a13399f8b0b`, commit `0f4240653d57ca54695261cdb3b70aabbafc7597`. Unused generic UI components and the binary favicon were omitted; banking screens, data, styles and routing are copied unchanged.

Start the app on loopback port 4173 using its pinned Bun lockfile:

```sh
cd sandboxes/meridian
bun install --frozen-lockfile --ignore-scripts
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort
```

From the runtime workspace, with `OPENROUTER_API_KEY` configured:

```sh
node --import tsx src/demo/meridian-test.ts --preflight
node --import tsx src/demo/meridian-test.ts
```

Use the bundled Node 24 or supported Node 22 runtime; the default shell's Node 23 does not match the package engine range. The live runner uses the explicitly selected `z-ai/glm-5.3-flash` slug and the existing default budget of 40 model tool calls. Preflight uses a scripted model without any provider request; its directory is labelled separately and is not agent evidence.

The live run opens a fresh visible Chromium context. Runtime policy evaluation was removed on 2026-10-07: all supported input/click actions, destinations, resources, frames and screenshots are available. The scenario's prompt asks for read-only account review; there is no runtime policy enforcing that instruction. The original test evidence below was collected before this policy removal.

Each OpenRouter request has a 120-second client deadline. Each run creates a timestamped directory in `artifacts/meridian/` with:

- `manifest.json`: source commit, seed, model, goal and run configuration. No credential values.
- `audit.jsonl`: durable ordered audit events with exact argument strings, parsed inputs, call IDs, model turns, timestamps, results and operation durations. Bootstrap is separate from model calls. Proposals that are not dispatched are marked distinctly.
- `screenshots/`: permitted tool observation images, referenced from their audit records.
- `timeline.md`: readable audit transcript generated at the end.
- `provider-metrics.jsonl`: provider HTTP status, response time, generation ID and token/cost usage; no raw response bodies or authorization headers.
- `result.json`, `report.json`, `final-ui.json`, `final-ui.png`: runtime outcome, independent fixture/UI comparison and final review evidence.

Audit writes happen before dispatch and after the result; a write failure halts execution instead of silently dropping calls. The audit includes automatic post-action observations inside each tool result; internal browser polling is not represented as a new model tool call. Inputs remain exact for this synthetic task; the runtime has no configurable redaction policy.

During the live run, `http://127.0.0.1:4180/` shows the audit as it grows. The supervised runner keeps Chromium and that viewer open after evaluation, for review only. Ctrl+C in the runner closes both; it does not support model continuation or takeover. The banking server is a separate process.

The agent receives the goal and output shape, never the expected fixture values. The evaluator checks the reported answer against the fixed oracle and verifies the final account URL, date/type filters, summary, row count and largest transaction evidence. A matching scenario is evaluated independently; the runtime still returns `awaiting_artifact_design` rather than claiming production capability persistence or replay.
