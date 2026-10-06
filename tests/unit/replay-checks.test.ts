import { it, expect } from "vitest";
import { evaluateCheck } from "../../src/replay/checks.js";
it("compares rendered control text rather than accessible label", () => {
  const capture: any = {
    observation: {
      status: "ok",
      controls: {
        status: "available",
        items: [
          {
            ref: "fresh",
            role: "text",
            name: "Status",
            text: "Active",
            state: {},
          },
        ],
      },
    },
  };
  const target = {
    kind: "semantic",
    role: "text",
    name: { kind: "literal", value: "Status" },
    exact: true,
    scope: null,
    required_matches: 1,
  };
  const verdict = evaluateCheck(
    {
      check_id: "status",
      kind: "control_text_equals",
      target,
      expected: { kind: "literal", value: "Active" },
    },
    capture,
    { inputs: {}, results: {}, environment: { base_url: "http://localhost" } },
  );
  expect(verdict.verdict).toBe("pass");
});
