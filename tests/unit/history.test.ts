import { validateToolResponse } from "../../src/runtime/tool-response.js";
import { it, expect } from "vitest";
import { ConversationHistory } from "../../src/runtime/history.js";
import type {
  Observation,
  ImageContent,
} from "../../src/contracts/observation.js";
import type { ToolResult, ToolName } from "../../src/contracts/tools.js";
import { createFileAudit, type AuditRecord } from "../../src/runtime/audit.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import { finalize } from "../../src/runtime/finalization.js";
import { convertNumber } from "../../src/adapters/browser/extraction.js";
const capture = (id: string): Observation => ({
  status: "ok",
  observation_id: id,
  captured_at: "2026-10-08T00:00:00.000Z",
  surface: {
    id: "s",
    kind: "browser",
    title: `Page ${id}`,
    url: `https://example.test/${id}`,
  },
  controls: {
    status: "available",
    items: [
      {
        ref: `${id}-input`,
        role: "textbox",
        name: "Customer",
        value: "Freya Ferreira",
        state: {},
      },
      {
        ref: `${id}-text`,
        role: "status",
        name: "Results",
        text: "No customers match these criteria.",
        state: {},
      },
    ],
  },
  screenshot: { status: "available", image_ref: id, width: 1, height: 1 },
});
const image = (id: string): ImageContent => ({
  ref: id,
  mimeType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
});
const appendResult = (
  h: ConversationHistory,
  id: string,
  name: ToolName,
  result: ToolResult,
) => {
  h.appendAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: [{ id, name, argumentsJson: "{}" }],
  });
  h.appendToolResult(id, result);
};
const toolResults = (h: ConversationHistory) =>
  (
    h.toOpenRouterMessages() as {
      role: string;
      content: string;
      tool_call_id?: string;
    }[]
  )
    .filter((m) => m.role === "tool")
    .map((m) => ({ id: m.tool_call_id, result: JSON.parse(m.content) }));

it("removes historical bootstrap observations and images while retaining the latest capture exactly", () => {
  const h = new ConversationHistory([
    { role: "user", content: "Find customer" },
  ]);
  h.appendUserObservation(capture("old"));
  h.appendObservationImage(image("old"), "old", "bootstrap");
  const latest = capture("latest");
  appendResult(h, "latest", "observe_ui", latest);
  h.appendObservationImage(image("latest"), "latest", "latest");
  const before = JSON.stringify(h.messages);
  const projected = h.toOpenRouterMessages() as {
    role: string;
    content: unknown;
  }[];
  expect(projected.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  expect(projected[0]).toEqual({ role: "user", content: "Find customer" });
  expect(projected[2]!.content).toBe(JSON.stringify(latest));
  expect(projected[3]).toEqual({
    role: "user",
    content: [
      {
        type: "text",
        text: "UNTRUSTED UI image; observation_id=latest; preceding_call_id=latest; image_ref=latest",
      },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("old");
  expect(JSON.stringify(h.messages)).toBe(before);
});

it("keeps the bootstrap capture complete while it is current", () => {
  const h = new ConversationHistory([]);
  const current = capture("bootstrap");
  h.appendUserObservation(current);
  h.appendObservationImage(image("bootstrap"), "bootstrap", "bootstrap");
  const projected = h.toOpenRouterMessages() as { content: unknown }[];
  expect(projected[0]!.content).toBe(
    `UNTRUSTED initial UI observation: ${JSON.stringify(current)}`,
  );
  expect(projected).toHaveLength(2);
});

it("retains the bootstrap navigation outcome when its nested observation becomes historical", () => {
  const h = new ConversationHistory([]);
  h.appendUserObservation({
    status: "completed",
    requested_url: "https://example.test/start",
    final_url: "https://example.test/home",
    observation: capture("old"),
  });
  appendResult(h, "latest", "observe_ui", capture("latest"));
  const projected = h.toOpenRouterMessages() as { content: string }[];
  expect(projected[0]!.content).toBe(
    'UNTRUSTED initial UI observation: {"status":"completed","requested_url":"https://example.test/start","final_url":"https://example.test/home"}',
  );
});

it("removes invalidated nested captures but keeps the failed action outcome", () => {
  const h = new ConversationHistory([]);
  appendResult(h, "old", "observe_ui", capture("old"));
  h.appendObservationImage(image("old"), "old", "old");
  appendResult(h, "failed", "click", {
    status: "uncertain",
    code: "CAPTURE_FAILED",
    reason: "Click dispatched; capture unavailable",
    observation: {
      status: "error",
      code: "CAPTURE_FAILED",
      message: "Observe again",
      retryable: true,
    },
  });
  expect(toolResults(h)).toEqual([
    { id: "old", result: { status: "ok" } },
    {
      id: "failed",
      result: {
        status: "uncertain",
        code: "CAPTURE_FAILED",
        reason: "Click dispatched; capture unavailable",
      },
    },
  ]);
  expect(
    (h.toOpenRouterMessages() as { role: string }[]).map((m) => m.role),
  ).toEqual(["assistant", "tool", "assistant", "tool"]);
});

it("retains only the success outcome of a historical observe_ui result", () => {
  const h = new ConversationHistory([]);
  appendResult(h, "old", "observe_ui", capture("old"));
  h.appendObservationImage(image("old"), "old", "old");
  appendResult(h, "latest", "observe_ui", capture("latest"));
  expect(toolResults(h)).toEqual([
    { id: "old", result: { status: "ok" } },
    { id: "latest", result: capture("latest") },
  ]);
  expect(JSON.stringify(h.toOpenRouterMessages())).not.toContain("old-input");
});

it.each([
  [
    "extract_data",
    {
      status: "partial",
      fields: {
        customer: { status: "extracted", value: " Freya\nFerreira " },
        count: { status: "extracted", value: 0 },
        missing: { status: "error", code: "NOT_FOUND", message: "No value" },
      },
      reason: "One missing field",
    },
  ],
  [
    "check_ui",
    {
      status: "evaluated",
      verdict: "fail",
      evidence: {
        property: "text",
        observed: "No customers match these criteria.",
      },
    },
  ],
  ["type_text", { status: "completed", verification: "matched" }],
  ["scroll", { status: "completed", movement: "no_movement" }],
  [
    "select_option",
    { status: "completed", verification: "matched", selected_label: "Active" },
  ],
  [
    "navigate",
    {
      status: "completed",
      requested_url: "https://example.test",
      final_url: "https://example.test/home",
    },
  ],
  ["wait_for", { status: "timed_out", elapsed_ms: 100, reason: "No match" }],
  [
    "click",
    {
      status: "uncertain",
      code: "ACTION_UNCERTAIN",
      reason: "Dispatched",
      blocker: { kind: "dialog", message: "Confirm?" },
      dialog_events: [
        {
          type: "confirm",
          message: "Confirm?",
          decision: "accept",
          action: "accepted",
        },
      ],
    },
  ],
] as const)(
  "preserves historical %s outcome fields exactly without its observation",
  (name, outcome) => {
    const h = new ConversationHistory([]);
    const result = validateToolResponse(name, {
      result: { ...outcome, observation: capture("old") } as ToolResult,
      image: image("old"),
    }).result;
    appendResult(h, "old", name, result);
    h.appendObservationImage(image("old"), "old", "old");
    appendResult(h, "latest", "observe_ui", capture("latest"));
    const original = JSON.stringify(h.messages);
    expect(toolResults(h)[0]).toEqual({ id: "old", result: outcome });
    expect(toolResults(h)[1]).toEqual({
      id: "latest",
      result: capture("latest"),
    });
    expect(JSON.stringify(h.messages)).toBe(original);
    expect(() =>
      validateToolResponse(name, { result: outcome as ToolResult }),
    ).toThrow();
  },
);

it("preserves current nested captures and non-observation errors/finalization outcomes exactly", () => {
  const h = new ConversationHistory([]);
  const latest: ToolResult = {
    status: "completed",
    fields: { name: { status: "extracted", value: "Freya" } },
    observation: capture("latest"),
  };
  appendResult(h, "extract", "extract_data", latest);
  const error: ToolResult = {
    status: "error",
    code: "INVALID_TOOL_CALL",
    message: "Bad input",
  };
  appendResult(h, "error", "click", error);
  const finish: ToolResult = {
    status: "accepted",
    outcome: "unable_to_complete",
  };
  appendResult(h, "finish", "finish_task", finish);
  expect(toolResults(h)).toEqual([
    { id: "extract", result: latest },
    { id: "error", result: error },
    { id: "finish", result: finish },
  ]);
});

it("leaves persisted audit results and screenshots unchanged during provider projection", () => {
  const directory = mkdtempSync(join(tmpdir(), "projection-audit-"));
  const sink = createFileAudit(directory);
  try {
    const h = new ConversationHistory([]);
    const old = capture("old");
    appendResult(h, "old", "observe_ui", old);
    h.appendObservationImage(image("old"), "old", "old");
    const record: AuditRecord = {
      type: "tool_finished",
      modelTurn: 1,
      call: { id: "old", name: "observe_ui", argumentsJson: '{"mode":"both"}' },
      result: old,
      elapsedMs: 1,
    };
    sink.write(record, image("old"));
    appendResult(h, "latest", "observe_ui", capture("latest"));
    const auditPath = join(directory, "audit.jsonl");
    const before = readFileSync(auditPath);
    const row = JSON.parse(before.toString());
    expect(row.result).toEqual(old);
    const screenshot = readFileSync(join(directory, row.screenshot));
    expect(screenshot).toEqual(Buffer.from([1, 2, 3]));
    const historyBefore = JSON.stringify(h.messages);
    expect(toolResults(h)[0]!.result).toEqual({ status: "ok" });
    expect(h.toOpenRouterMessages()).toEqual(h.toOpenRouterMessages());
    expect(JSON.stringify(h.messages)).toBe(historyBefore);
    expect(record.result).toEqual(old);
    expect(readFileSync(auditPath)).toEqual(before);
    expect(readFileSync(join(directory, row.screenshot))).toEqual(screenshot);
  } finally {
    sink.close();
    rmSync(directory, { recursive: true });
  }
});
it.each(["STALE_OBSERVATION", "CAPTURE_FAILED"])(
  "does not expose expired controls or images after %s",
  (code) => {
    const h = new ConversationHistory([]);
    h.appendUserObservation({
      status: "ok",
      observation_id: "old",
      captured_at: new Date().toISOString(),
      surface: { id: "s", kind: "browser", title: "Desk" },
      controls: { status: "available", items: [] },
      screenshot: {
        status: "available",
        image_ref: "old",
        width: 1,
        height: 1,
      },
    });
    h.appendObservationImage(
      { ref: "old", mimeType: "image/png", bytes: new Uint8Array([1]) },
      "old",
      "bootstrap",
    );
    h.appendAssistantToolCalls({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "failed", name: "observe_ui", argumentsJson: "{}" }],
    });
    h.appendToolResult("failed", {
      status: "error",
      code,
      message: "Observe again",
    });
    const projected = h.toOpenRouterMessages() as {
      role: string;
      content: any;
    }[];
    expect(projected.filter((m) => Array.isArray(m.content))).toHaveLength(0);
    expect(projected.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(JSON.parse(projected.at(-1)!.content).code).toBe(code);
  },
);
it("keeps tool-result batches contiguous while pairing each image with its call ID", () => {
  const h = new ConversationHistory([]);
  const calls = ["a", "b"].map((id) => ({
    id,
    name: "observe_ui",
    argumentsJson: '{"mode":"both"}',
  }));
  h.appendAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: calls,
  });
  h.appendToolResult("a", capture("a"));
  h.appendObservationImage(image("a"), "a", "a");
  h.appendToolResult("b", capture("b"));
  h.appendObservationImage(image("b"), "b", "b");
  const projected = h.toOpenRouterMessages() as {
    role: string;
    content: unknown;
  }[];
  expect(projected.map((x) => x.role)).toEqual([
    "assistant",
    "tool",
    "tool",
    "user",
  ]);
  expect(JSON.stringify(projected.at(-1))).toContain("preceding_call_id=b");
  expect(() =>
    h.appendAssistantToolCalls({
      role: "assistant",
      content: null,
      tool_calls: calls,
    }),
  ).toThrow();
});
it("accepts reporting completion without enforcing semantic output or business-code contracts", () => {
  const p = syntheticContract();
  for (const input of [
    { outcome: "goal_achieved" as const, summary: "done", outputs: {} },
    {
      outcome: "business_outcome" as const,
      outcome_code: "bogus",
      summary: "done",
    },
    {
      outcome: "unable_to_complete" as const,
      outputs: { extra: [null] },
      summary: "done",
    },
  ])
    expect(finalize(input, p)).toMatchObject({
      status: "accepted",
      outcome: input.outcome,
    });
});
it("only accepts finite plain decimal numbers", () => {
  for (const s of [
    "",
    " ",
    "$10",
    "1,000",
    "NaN",
    "Infinity",
    "1e2",
    ".2",
    "2.",
    "1".repeat(400),
  ])
    expect(convertNumber(s)).toBeUndefined();
  for (const [s, n] of [
    ["-12.50", -12.5],
    ["+2", 2],
    ["0", 0],
  ] as const)
    expect(convertNumber(s)).toBe(n);
});
it("preserves screenshots and rejects missing image bytes or private protocol members", () => {
  const result = {
    status: "ok" as const,
    observation_id: "o",
    captured_at: new Date().toISOString(),
    surface: { id: "s", kind: "browser" as const, title: "safe" },
    controls: { status: "not_requested" as const },
    screenshot: {
      status: "available" as const,
      image_ref: "i",
      width: 1,
      height: 1,
    },
  };
  const image = {
    ref: "i",
    mimeType: "image/png" as const,
    bytes: Buffer.from("png"),
  };
  expect(validateToolResponse("observe_ui", { result, image }).image).toEqual(
    image,
  );
  expect(() => validateToolResponse("observe_ui", { result })).toThrow(
    "Missing image bytes",
  );
  expect(() =>
    validateToolResponse("observe_ui", {
      result,
      image: { ...image, ref: "wrong" },
    }),
  ).toThrow("Missing image bytes");
  expect(() =>
    validateToolResponse("observe_ui", {
      result: { ...result, bindings: new Map() } as never,
      image,
    }),
  ).toThrow();
});
it("projects runtime corrections into the leading system message without mutating canonical history", () => {
  const history = new ConversationHistory([
    { role: "system", content: "Base rules" },
    { role: "user", content: "Task" },
  ]);
  history.messages.push({
    role: "system",
    content: "Trusted runtime correction: test",
  });
  const before = structuredClone(history.messages);
  expect(history.toOpenRouterMessages()).toEqual([
    {
      role: "system",
      content: "Base rules\n\nTrusted runtime correction: test",
    },
    { role: "user", content: "Task" },
  ]);
  expect(history.messages).toEqual(before);
});

it("expires trusted correction instructions after the corrected model turn while retaining the audit history", () => {
  const history = new ConversationHistory([
    { role: "system", content: "Base rules" },
    { role: "system", content: "Trusted runtime correction: test" },
  ]);
  history.appendAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "corrected", name: "observe_ui", argumentsJson: "{}" }],
  });
  history.appendToolResult("corrected", {
    status: "error",
    code: "TEST",
    message: "result",
  });
  expect(history.toOpenRouterMessages()[0]).toEqual({
    role: "system",
    content: "Base rules",
  });
  expect(history.messages[1]).toEqual({
    role: "system",
    content: "Trusted runtime correction: test",
  });
});
