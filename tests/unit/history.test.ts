import { validateToolResponse } from "../../src/runtime/tool-response.js";
import { it, expect } from "vitest";
import { ConversationHistory } from "../../src/runtime/history.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import { finalize } from "../../src/runtime/finalization.js";
import { convertNumber } from "../../src/adapters/browser/extraction.js";
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
