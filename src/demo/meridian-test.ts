import { createServer } from "node:http";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BrowserAdapter } from "../adapters/browser/browser-adapter.js";
import { runTask } from "../runtime/run-task.js";
import { createFileAudit } from "../runtime/audit.js";
import { toolResultSchemas } from "../contracts/tools.js";
import { OpenRouterClient } from "../llm/openrouter-client.js";
import { loadOpenRouterConfig } from "../runtime/config.js";
import type { Observation, Control } from "../contracts/observation.js";
import type { AgentTurn } from "../contracts/run.js";

const preflight = process.argv.includes("--preflight");
const targetUrl = "http://127.0.0.1:4173/";
const modelSlug = "z-ai/glm-5.3-flash";
const sourceCommit = "0f4240653d57ca54695261cdb3b70aabbafc7597";
const directory = resolve(
  "artifacts/meridian",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${preflight ? "preflight" : "glm-5.3-flash"}`,
);
mkdirSync(directory, { recursive: true });
const audit = createFileAudit(directory);
let latest: Extract<Observation, { status: "ok" }> | undefined;
let actualClose: (() => Promise<void>) | undefined;
const fields = z.strictObject({
  customer_id: z.string(),
  account_number: z.string(),
  debit_count: z.number().int(),
  total_debits: z.string(),
  largest_debit: z.strictObject({
    amount: z.string(),
    date: z.string(),
    description: z.string(),
    transaction_id: z.string(),
  }),
});
const expected = {
  customer_id: "C911174",
  account_number: "012-6204413",
  debit_count: 10,
  total_debits: "$5,089.32",
  largest_debit: {
    amount: "$858.85",
    date: "2026-01-13",
    description: "CARD PURCHASE - FUEL STOP",
    transaction_id: "TX-0126204413-0027",
  },
};
const goal = `Find Casimir Whitlock's Savings account ending 4413 at Harbor Street. Using only the banking UI, review DEBIT transactions from 2026-01-01 through 2026-01-31 inclusive. Report customer ID, full account number, debit transaction count, total debits and the largest debit's amount, date, description and transaction ID. Leave account data unchanged; do not edit contact details, request limits, print or export files, or enter supervisor/developer screens. Verify the filters and extract the requested evidence with extract_data. Call finish_task with outcome goal_achieved and outputs shaped as {customer_id:string,account_number:string,debit_count:number,total_debits:string,largest_debit:{amount:string,date:string,description:string,transaction_id:string}}. Report positive debit amounts as currency strings including dollar sign and thousands separators. Never guess references or values.`;
const controls = () =>
  latest?.controls.status === "available" ? latest.controls.items : [];
const contract = {
  validateOutputs: (output: Record<string, unknown>) =>
    fields.safeParse(output).success,
};
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(
    {
      model: preflight ? "scripted-preflight-no-model" : modelSlug,
      targetUrl,
      sourceCommit,
      fixtureSeed: 1001,
      scenarioFlags: "all off",
      goal,
      maxToolCalls: 40,
      providerRequestTimeoutMs: preflight ? null : 120000,
      browser: "fresh Chromium context",
      execution:
        "Unrestricted browser; task requests read-only banking actions",
      outputs: fields.toJSONSchema?.(),
    },
    null,
    2,
  ),
);

const viewer = `<!doctype html><meta charset="utf-8"><title>Meridian agent audit</title><style>body{font:14px system-ui;margin:24px;max-width:1100px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:12px}details{border-bottom:1px solid #ddd;padding:8px}img{max-width:100%}summary{cursor:pointer}#state{font-weight:600}</style><h1>Meridian agent audit</h1><p id="state">Waiting for tool calls…</p><p>Exact ordered inputs and results. Banking UI runs in the separate Chromium window.</p><div id="rows"></div><script>let count=-1;async function refresh(){const res=await fetch('/audit.jsonl');const text=await res.text();const rows=text.trim().split('\\n').filter(Boolean).map(x=>JSON.parse(x));if(rows.length===count)return;count=rows.length;document.getElementById('state').textContent=rows.length+' audit records · '+(rows.at(-1)?.type??'waiting');const parent=document.getElementById('rows');parent.replaceChildren();for(const r of rows){const d=document.createElement('details');const s=document.createElement('summary');s.textContent='#'+r.sequence+' '+r.timestamp+' '+r.type+' '+(r.call?.name??'')+' '+(r.result?.status??'');d.append(s);const p=document.createElement('pre');p.textContent=JSON.stringify(r,null,2);d.append(p);if(r.screenshot){const im=document.createElement('img');im.src='/'+r.screenshot;d.append(im)}parent.append(d)}}refresh();setInterval(refresh,1000)</script>`;
writeFileSync(join(directory, "audit.html"), viewer);
const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(viewer);
    return;
  }
  if (path === "/audit.jsonl" || /^\/screenshots\/\d+\.png$/.test(path)) {
    const file = join(directory, path.slice(1));
    if (existsSync(file)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Type",
        path.endsWith(".png") ? "image/png" : "application/x-ndjson",
      );
      res.end(readFileSync(file));
      return;
    }
  }
  res.writeHead(404);
  res.end();
});

function scriptedPreflight() {
  let step = 0;
  const find = (name: string, last = false): Control => {
    const found = controls().filter(
      (c) =>
        c.name === name &&
        ["textbox", "combobox", "button", "link"].includes(c.role),
    );
    const c = last ? found.at(-1) : found[0];
    if (!c) throw new Error(`Preflight missing ${name}`);
    return c;
  };
  const target = (name: string, last = false) => ({
    kind: "control",
    control_ref: find(name, last).ref,
  });
  return {
    model: "scripted-preflight",
    async complete(): Promise<AgentTurn> {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const id = latest!.observation_id;
      if (step === 0 && !controls().some((c) => c.name === "Customer name")) {
        const calls = [
          {
            id: `preflight-init-${id}`,
            name: "observe_ui",
            argumentsJson: '{"mode":"both"}',
          },
        ];
        return {
          kind: "tool_calls",
          calls,
          assistantMessage: {
            role: "assistant",
            content: null,
            tool_calls: calls,
          },
        };
      }
      const planned = [
        () => ({
          name: "type_text",
          input: {
            observation_id: id,
            target: target("Customer name"),
            mode: "replace",
            text: "Casimir Whitlock",
          },
        }),
        () => ({
          name: "click",
          input: { observation_id: id, target: target("Search", true) },
        }),
        () => ({ name: "observe_ui", input: { mode: "both" } }),
        () => ({
          name: "click",
          input: {
            observation_id: id,
            target: target("Open Casimir Whitlock C911174"),
          },
        }),
        () => ({ name: "observe_ui", input: { mode: "both" } }),
        () => ({
          name: "click",
          input: {
            observation_id: id,
            target: target("Transactions for 012-6204413"),
          },
        }),
        () => ({ name: "observe_ui", input: { mode: "both" } }),
        () => ({
          name: "type_text",
          input: {
            observation_id: id,
            target: target("From date"),
            mode: "replace",
            text: "2026-01-01",
          },
        }),
        () => ({
          name: "type_text",
          input: {
            observation_id: id,
            target: target("To date"),
            mode: "replace",
            text: "2026-01-31",
          },
        }),
        () => ({
          name: "select_option",
          input: {
            observation_id: id,
            target: target("Type"),
            option: { label: "Debit" },
          },
        }),
        () => ({
          name: "click",
          input: { observation_id: id, target: target("Apply filter") },
        }),
        () => ({
          name: "click",
          input: { observation_id: id, target: target("Amount") },
        }),
        () => ({
          name: "finish_task",
          input: {
            observation_id: id,
            outcome: "goal_achieved",
            summary: "Scripted UI preflight only",
            outputs: expected,
          },
        }),
      ];
      const p = planned[step++]!();
      const calls = [
        {
          id: `preflight-${step}`,
          name: p.name,
          argumentsJson: JSON.stringify(p.input),
        },
      ];
      return {
        kind: "tool_calls",
        calls,
        assistantMessage: {
          role: "assistant",
          content: null,
          tool_calls: calls,
        },
      };
    },
  };
}

async function main() {
  if (!preflight && !process.env.OPENROUTER_API_KEY?.trim())
    throw new Error("Missing configured provider key");
  if (!preflight)
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(4180, "127.0.0.1", resolve);
    });
  let request = 0;
  const client = preflight
    ? scriptedPreflight()
    : new OpenRouterClient(
        loadOpenRouterConfig({ ...process.env, OPENROUTER_MODEL: modelSlug }),
        async (input, init) => {
          const started = performance.now();
          const response = await fetch(input, init);
          const metadata = (await response
            .clone()
            .json()
            .catch(() => ({}))) as {
            id?: string;
            usage?: unknown;
            error?: { code?: number };
          };
          appendFileSync(
            join(directory, "provider-metrics.jsonl"),
            JSON.stringify({
              request: ++request,
              timestamp: new Date().toISOString(),
              status: response.status,
              elapsedMs: Math.round(performance.now() - started),
              generationId: metadata.id,
              usage: metadata.usage,
              errorCode: metadata.error?.code,
            }) + "\n",
            { mode: 0o600 },
          );
          return response;
        },
      );
  const result = await runTask(
    { goal, targetUrl },
    {
      model: client,
      contract,
      adapterFactory: {
        async createForTask() {
          const adapter = await BrowserAdapter.create({
            headless: preflight,
            captureMs: 15000,
            viewport: { width: 1440, height: 900 },
            slowMo: 0,
          });
          actualClose = adapter.close.bind(adapter);
          // This supervised test runner owns final cleanup and keeps the review window visible.
          adapter.close = async () => {
            const capture = await adapter.capture("both");
            writeFileSync(
              join(directory, "final-ui.json"),
              JSON.stringify(capture.observation, null, 2),
            );
            if (capture.image)
              writeFileSync(
                join(directory, "final-ui.png"),
                capture.image.bytes,
              );
            if (capture.observation.status === "ok")
              latest = capture.observation;
            if (preflight) await actualClose!();
          };
          return adapter;
        },
      },
    },
    {
      maxToolCalls: 40,
      onAudit: (record, image) => {
        audit.write(record, image);
        if (record.type === "tool_finished") {
          const r = record.result;
          const o =
            "observation" in r
              ? r.observation
              : r.status === "ok"
                ? r
                : undefined;
          if (o?.status === "ok") latest = o;
          console.log(`${record.modelTurn}: ${record.call.name} → ${r.status}`);
        }
      },
    },
  );
  audit.close();
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  const c = controls();
  const url = new URL(latest?.surface.url ?? targetUrl);
  const names = c.map((c) => c.name);
  const uiChecks = {
    correctAccountPage: url.pathname === "/accounts/012-6204413/transactions",
    correctDateRange:
      url.searchParams.get("from") === "2026-01-01" &&
      url.searchParams.get("to") === "2026-01-31",
    debitFilter:
      url.searchParams.get("type") === "debit" &&
      c.some((c) => c.name === "Type" && c.value === "debit"),
    summary: names.some(
      (n) =>
        n ===
        "Matching: 10 · Debits $5,089.32 · Credits $0.00 · Net -$5,089.32",
    ),
    tenRows: names.filter((n) => /^TX-0126204413-\d{4}$/.test(n)).length === 10,
    largestVisible:
      names.includes("TX-0126204413-0027") &&
      names.includes("-$858.85") &&
      names.includes("2026-01-13") &&
      names.includes("CARD PURCHASE - FUEL STOP"),
  };
  const actual = fields.safeParse(result.outputs);
  const answerMatches =
    actual.success &&
    Object.entries(expected).every(
      ([key, value]) =>
        JSON.stringify(actual.data[key as keyof typeof expected]) ===
        JSON.stringify(value),
    );
  const report = {
    test: "Meridian January debit lookup",
    kind: preflight ? "scripted UI preflight; no model" : "live model test",
    model: preflight ? "scripted" : modelSlug,
    passed:
      result.status === "goal_achieved" &&
      answerMatches &&
      Object.values(uiChecks).every(Boolean),
    runtimeStatus: result.status,
    answerMatches,
    uiChecks,
    expected,
    actual: result.outputs,
    toolCallsUsed: result.toolCallsUsed,
    auditDirectory: directory,
    formalCapabilityCompletion:
      "deferred; independent scenario evaluation only",
  };
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  const rows = readFileSync(join(directory, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  writeFileSync(
    join(directory, "timeline.md"),
    `# Meridian test audit\n\n${rows.map((r) => `## ${r.sequence}. ${r.timestamp} — ${r.type}${r.call ? " / " + r.call.name : ""}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`\n`).join("\n")}`,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!preflight) {
    console.log(
      "Browser and audit viewer remain open for review: http://127.0.0.1:4180/ · Ctrl+C closes this supervised run.",
    );
    process.once("SIGINT", () => {
      void actualClose?.().finally(() => server.close(() => process.exit(0)));
    });
  }
}
main().catch(async () => {
  console.error(
    "Test runner stopped; inspect local audit records. Provider credentials and raw error bodies are not printed.",
  );
  await actualClose?.();
  server.close();
  process.exitCode = 1;
});
