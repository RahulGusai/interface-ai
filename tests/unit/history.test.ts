import { validateToolResponse } from "../../src/runtime/tool-response.js";
import { it, expect } from "vitest";
import { ConversationHistory } from "../../src/runtime/history.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import { finalize } from "../../src/runtime/finalization.js";
import { convertNumber } from "../../src/adapters/browser/extraction.js";
it("retains historical empty-search evidence and input values after clearing the form without expired targeting data", () => {
  const h = new ConversationHistory([]);
  const capture = (id: string, items: any[]) => ({
    status: "ok" as const,
    observation_id: id,
    captured_at: new Date().toISOString(),
    surface: { id: "s", kind: "browser" as const, title: "Customer Search" },
    controls: { status: "available" as const, items },
    screenshot: { status: "not_requested" as const },
  });
  h.appendUserObservation(
    capture("search-result", [
      {
        ref: "old-name",
        role: "textbox",
        name: "Customer name",
        text: "",
        value: "Freya Ferreira",
        state: {},
      },
      {
        ref: "old-results",
        role: "status",
        name: "Results",
        text: "(0 customers)\nNo customers match these criteria.",
        state: {},
      },
      {
        ref: "duplicate",
        role: "text",
        name: "No customers match these criteria.",
        text: "No customers match these criteria.",
        state: {},
      },
      {
        ref: "seed",
        role: "text",
        name: "Fixture seed 1001",
        text: "Fixture seed 1001",
        state: {},
      },
    ]),
  );
  h.appendAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "clear", name: "click", argumentsJson: "{}" }],
  });
  h.appendToolResult("clear", {
    status: "completed",
    observation: capture("cleared", []),
  });
  const original = JSON.stringify(h.messages);
  const projected = h.toOpenRouterMessages() as { content: string }[];
  const historical = JSON.parse(
    projected[0]!.content.split("UNTRUSTED initial UI observation: ")[1]!,
  );
  expect(historical.visible_text).toContain(
    "No customers match these criteria.",
  );
  expect(
    historical.visible_text.filter(
      (s: string) => s === "No customers match these criteria.",
    ),
  ).toHaveLength(1);
  expect(historical.visible_text).toContain("Fixture seed 1001");
  expect(historical.input_values).toEqual([
    { name: "Customer name", value: "Freya Ferreira" },
  ]);
  expect(historical.controls).toBeUndefined();
  expect(JSON.stringify(historical)).not.toContain("old-name");
  expect(JSON.stringify(h.messages)).toBe(original);
});
it("projects only current controls and screenshot while retaining tool outcomes and full internal history", () => {
  const h = new ConversationHistory([]);
  for (const id of ["a", "b"]) {
    const calls = [
      { id, name: "observe_ui", argumentsJson: '{"mode":"both"}' },
    ];
    h.appendAssistantToolCalls({
      role: "assistant",
      content: null,
      tool_calls: calls,
    });
    h.appendToolResult(id, {
      status: "ok",
      observation_id: id,
      captured_at: new Date().toISOString(),
      surface: { id: "s", kind: "browser", title: id },
      controls: {
        status: "available",
        items: [{ ref: id, role: "text", name: id, state: {} }],
      },
      screenshot: { status: "available", image_ref: id, width: 1, height: 1 },
    });
    h.appendObservationImage(
      { ref: id, mimeType: "image/png", bytes: new Uint8Array([1]) },
      id,
      id,
    );
  }
  const before = JSON.stringify(h.messages);
  const projected = h.toOpenRouterMessages() as {
    role: string;
    content: any;
    tool_call_id?: string;
  }[];
  const results = projected.filter((m) => m.role === "tool");
  expect(results.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
  expect(JSON.parse(results[0]!.content)).toMatchObject({
    status: "ok",
    observation_id: "a",
    context_note: expect.stringContaining("Historical"),
  });
  expect(JSON.parse(results[0]!.content).controls).toBeUndefined();
  expect(JSON.parse(results[1]!.content).controls.items[0].ref).toBe("b");
  const images = projected.filter((m) => m.role === "user");
  expect(images).toHaveLength(1);
  expect(JSON.stringify(images[0])).toContain("observation_id=b");
  expect(JSON.stringify(h.messages)).toBe(before);
});
it("omits obsolete initial UI detail while retaining extracted data and verification", () => {
  const h = new ConversationHistory([]);
  const capture = (id: string) => ({
    status: "ok" as const,
    observation_id: id,
    captured_at: new Date().toISOString(),
    surface: { id: "s", kind: "browser" as const, title: "Desk" },
    controls: { status: "available" as const, items: [] },
    screenshot: { status: "not_requested" as const },
  });
  h.appendUserObservation({ status: "completed", observation: capture("old") });
  const calls = [{ id: "x", name: "extract_data", argumentsJson: "{}" }];
  h.appendAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: calls,
  });
  h.appendToolResult("x", {
    status: "completed",
    observation: capture("new"),
    fields: { balance: { status: "extracted", value: 25 } },
  });
  const projected = h.toOpenRouterMessages() as {
    role: string;
    content: string;
  }[];
  expect(projected[0]!.content).not.toContain('"controls"');
  expect(JSON.parse(projected.at(-1)!.content).fields).toEqual({
    balance: { status: "extracted", value: 25 },
  });
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
    expect(projected[0]!.content).not.toContain('"controls"');
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
  h.appendToolResult("a", { status: "error", code: "X", message: "x" });
  h.appendObservationImage(
    { ref: "i", mimeType: "image/png", bytes: new Uint8Array([1]) },
    "o",
    "a",
  );
  h.appendToolResult("b", { status: "error", code: "X", message: "x" });
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
  expect(JSON.stringify(projected.at(-1))).toContain("preceding_call_id=a");
  expect(() =>
    h.appendAssistantToolCalls({
      role: "assistant",
      content: null,
      tool_calls: calls,
    }),
  ).toThrow();
});
it("does not fabricate artifact acceptance or accept unknown outputs/business codes", () => {
  const p = syntheticContract();
  expect(
    finalize(
      { observation_id: "o", outcome: "goal_achieved", summary: "done" },
      p,
    ),
  ).toMatchObject({
    status: "rejected",
    code: "ARTIFACT_INTEGRATION_REQUIRED",
  });
  expect(
    finalize(
      {
        observation_id: "o",
        outcome: "business_outcome",
        outcome_code: "bogus",
        summary: "done",
      },
      p,
    ),
  ).toMatchObject({ status: "rejected" });
  expect(
    finalize(
      {
        observation_id: "o",
        outcome: "unable_to_complete",
        outputs: { secret: "bad" },
        summary: "done",
      },
      p,
    ),
  ).toMatchObject({ status: "rejected" });
  expect(
    finalize(
      {
        observation_id: "o",
        outcome: "business_outcome",
        outcome_code: "not_found",
        summary: "No member",
      },
      p,
    ),
  ).toMatchObject({ status: "accepted" });
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
