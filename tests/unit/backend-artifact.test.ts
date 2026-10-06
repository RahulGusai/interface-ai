import { describe, it, expect } from "vitest";
import { parseArtifact, validateValues } from "../../src/contracts/artifact.js";
import { resolveBindings } from "../../src/replay/bindings.js";
const schema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    enabled: { type: "boolean", default: true },
  },
  required: ["email"],
  additionalProperties: false,
};
export const definition = {
  surface: "browser",
  compatibility: {
    product_id: "desk",
    ui_variant: "standard",
    vendor_release: null,
  },
  input_schema: schema,
  output_schema: {
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
    additionalProperties: false,
  },
  entry: { url: { kind: "environment", path: "base_url" }, checks: [] },
  steps: [
    {
      step_id: "s1",
      tool: "extract_data",
      arguments: {
        fields: [
          {
            name: "status",
            target: {
              kind: "semantic",
              role: "text",
              name: { kind: "literal", value: "Active" },
              exact: true,
              scope: null,
              required_matches: 1,
            },
            property: "text",
            output_type: "string",
          },
        ],
      },
      pre_checks: [],
      post_checks: [],
      recoveries: [],
    },
  ],
  success_checks: [
    {
      check_id: "success",
      kind: "tool_status_equals",
      step_id: "s1",
      expected: "completed",
    },
  ],
  business_outcomes: [],
  output_mapping: {
    status: { kind: "step_output", step_id: "s1", path: "fields.status.value" },
  },
};
describe("durable artifact", () => {
  it("preserves primitive types and resolves declared bindings", () => {
    expect(parseArtifact(definition).steps).toHaveLength(1);
    expect(validateValues(schema, { email: "a@example.test" })).toEqual({
      email: "a@example.test",
      enabled: true,
    });
    expect(
      resolveBindings(
        { kind: "input", path: "enabled" },
        { enabled: false },
        {},
        { base_url: "http://localhost" },
      ),
    ).toBe(false);
    expect(() => validateValues(schema, { email: "bad" })).toThrow();
  });
  it("rejects stale refs, forward refs, duplicate IDs and absolute URLs", () => {
    for (const mutation of [
      {
        ...definition,
        steps: [{ ...definition.steps[0], arguments: { control_ref: "c1" } }],
      },
      { ...definition, steps: [definition.steps[0], definition.steps[0]] },
      {
        ...definition,
        steps: [
          {
            ...definition.steps[0],
            arguments: {
              value: { kind: "step_output", step_id: "s1", path: "x" },
            },
          },
        ],
      },
      {
        ...definition,
        entry: {
          url: { kind: "literal", value: "https://tenant.test" },
          checks: [],
        },
      },
    ])
      expect(() => parseArtifact(mutation)).toThrow();
  });
});
it("rejects business checks that read a future step", () => {
  const bad = structuredClone(definition) as any;
  bad.steps.push({ ...bad.steps[0], step_id: "s2" });
  bad.business_outcomes = [
    {
      code: "early",
      message: "Early outcome",
      after_step_id: "s1",
      checks: [
        {
          check_id: "future",
          kind: "field_equals",
          actual: {
            kind: "step_output",
            step_id: "s2",
            path: "fields.status.value",
          },
          expected: { kind: "literal", value: "Active" },
        },
      ],
      output_mapping: {},
    },
  ];
  expect(() => parseArtifact(bad)).toThrow("FORWARD");
});
it("requires trusted URL bindings for every saved navigation", () => {
  const bad = structuredClone(definition) as any;
  bad.steps[0] = {
    step_id: "s1",
    tool: "navigate",
    arguments: { url: "http://tenant.example/members" },
    pre_checks: [],
    post_checks: [],
    recoveries: [],
  };
  expect(() => parseArtifact(bad)).toThrow();
});
import { readFileSync } from "node:fs";
it("uses shared email acceptance and default cases", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("../../contracts/value-validation-cases.json", import.meta.url),
      "utf8",
    ),
  );
  const schema = {
    type: "object",
    properties: { email: { type: "string", format: "email" } },
    required: ["email"],
    additionalProperties: false,
  };
  for (const c of cases) {
    if (c.valid) {
      expect(validateValues(schema, { email: c.value }).email).toBe(c.value);
      expect(
        validateValues(
          {
            ...schema,
            properties: {
              email: { ...schema.properties.email, default: c.value },
            },
          },
          {},
        ).email,
      ).toBe(c.value);
    } else expect(() => validateValues(schema, { email: c.value })).toThrow();
  }
});
