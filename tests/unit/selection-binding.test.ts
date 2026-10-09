import { it, expect } from "vitest";
import { assertBoundArguments } from "../../src/runtime/discovery-bindings.js";
it("rejects frozen option prefixes while retaining direct input selectors", () => {
  const inputs = { location: "Harbor Street" };
  expect(() =>
    assertBoundArguments(
      "select_option",
      {
        option: {
          label: {
            kind: "template",
            parts: ["012 — ", { kind: "input", path: "location" }],
          },
          match: "exact",
        },
      },
      inputs,
    ),
  ).toThrowError(/SELECT_INPUT_REQUIRED/);
  expect(() =>
    assertBoundArguments(
      "select_option",
      {
        option: {
          label: { kind: "input", path: "location" },
          match: "contains",
        },
      },
      inputs,
    ),
  ).not.toThrow();
  expect(() =>
    assertBoundArguments(
      "type_text",
      {
        text: {
          kind: "template",
          parts: ["Location: ", { kind: "input", path: "location" }],
        },
      },
      inputs,
    ),
  ).not.toThrow();
});
