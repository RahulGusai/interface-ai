import { expect, it } from "vitest";
import { requiresReview } from "../../src/contracts/execution.js";
import { toolDefinitions } from "../../src/contracts/tools.js";
it.each([
  undefined,
  null,
  {},
  { decision: "auto_approve", confidence: "0.9", reason: "x" },
  { decision: "auto_approve", confidence: NaN, reason: "x" },
  { decision: "auto_approve", confidence: 1.1, reason: "x" },
  { decision: "auto_approve", confidence: 1, reason: "" },
  { decision: "auto_approve", confidence: 0.299, reason: "x" },
  { decision: "requires_human_review", confidence: 1, reason: "x" },
])("routes invalid, uncertain and explicit assessments to review: %j", (raw) =>
  expect(requiresReview(raw)).toBe(true),
);
it.each([0.3, 0.9, 1])("accepts auto approval at %s", (confidence) =>
  expect(
    requiresReview({
      decision: "auto_approve",
      confidence,
      reason: "Read visible UI",
    }),
  ).toBe(false),
);
it("requires execution metadata in every provider tool schema", () => {
  for (const tool of toolDefinitions)
    expect((tool.function.parameters as any).required).toContain("execution");
});
