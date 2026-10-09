import { expect, it } from "vitest";
import { unusedDiscoveryInputs } from "../../src/runtime/input-coverage.js";
const ref = { kind: "input", path: "branch" };
const context = (records: any[]) =>
  ({
    metadata: { input_schema: { properties: { branch: {} } } },
    records,
  }) as any;
it("ignores failed calls, literal-wrapped objects and incidental reference-shaped data", () => {
  expect(
    unusedDiscoveryInputs(
      context([
        {
          tool: "click",
          input: { row_match: { branch: ref } },
          result: { status: "blocked" },
        },
        {
          tool: "check_ui",
          input: { condition: { expected: ref } },
          result: { status: "completed", verdict: "fail" },
        },
        {
          tool: "extract_data",
          input: { fields: [{ name: ref }] },
          result: { status: "completed" },
        },
        {
          tool: "type_text",
          input: { text: { kind: "literal", value: ref } },
          result: { status: "completed" },
        },
      ]),
    ),
  ).toEqual(["branch"]);
});
it("counts successful explicit bindings in row criteria and field checks", () => {
  expect(
    unusedDiscoveryInputs(
      context([
        {
          tool: "extract_data",
          input: {
            fields: [
              { row_match: { branch: { operator: "contains", value: ref } } },
            ],
          },
          result: { status: "completed" },
        },
      ]),
    ),
  ).toEqual([]);
});
