import { expect, it } from "vitest";
import { buildArtifact } from "../../src/runtime/artifact-builder.js";
import { parseArtifact, validateValues } from "../../src/contracts/artifact.js";
import { finishTaskInput } from "../../src/contracts/finish-task.draft.js";
import { toolDefinitions } from "../../src/contracts/tools.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
const target = (name: string) => ({
  kind: "semantic" as const,
  role: "text",
  name: { kind: "literal", value: name },
  exact: true as const,
  scope: null,
  required_matches: 1 as const,
});
const context = (): DiscoveryContext => ({
  deployment: {
    app_deployment_id: "test",
    base_url: "https://example.org/app",
    product_id: "desk",
    ui_variant: "standard",
    vendor_release: null,
    config_version: 1,
  },
  capability_catalog: [],
  inputs: {},
  references: [],
  records: [
    {
      call_id: "bootstrap",
      tool: "navigate",
      input: { url: "https://example.org/app" },
      result: { status: "completed" },
    },
    {
      call_id: "read",
      tool: "extract_data",
      input: {
        observation_id: "old",
        fields: [
          {
            name: "balance",
            target: { kind: "control", control_ref: "c1" },
            property: "text",
            output_type: "string",
          },
        ],
        _durable_fields: { balance: target("Balance") },
      },
      result: {
        status: "completed",
        fields: { balance: { status: "extracted", value: "10" } },
      },
    },
    {
      call_id: "click",
      tool: "click",
      input: {
        observation_id: "old",
        target: { kind: "control", control_ref: "c2" },
      },
      target: target("Transactions"),
      result: { status: "completed" },
    },
  ],
});
it("advertises a small finish schema and requires only outcome, summary, and object outputs on success", () => {
  const schema: any = toolDefinitions.find(
    (d) => d.function.name === "finish_task",
  )!.function.parameters;
  expect(schema.properties).not.toHaveProperty("proposal");
  expect(schema.properties).not.toHaveProperty("observation_id");
  expect(
    finishTaskInput.parse({
      outcome: "goal_achieved",
      summary: "Done",
      outputs: {},
      proposal: "malformed",
      observation_id: "stale",
    }),
  ).toEqual({ outcome: "goal_achieved", summary: "Done", outputs: {} });
  for (const outputs of [undefined, null, [], "value"])
    expect(
      finishTaskInput.safeParse({
        outcome: "goal_achieved",
        summary: "Done",
        outputs,
      }).success,
    ).toBe(false);
  expect(
    finishTaskInput.safeParse({
      outcome: "goal_achieved",
      summary: "   ",
      outputs: {},
    }).success,
  ).toBe(false);
  expect(
    finishTaskInput.safeParse({
      outcome: "unable_to_complete",
      summary: "Missing record",
    }).success,
  ).toBe(true);
});
it("builds one ordered step per action and associates each target without lookup or a recorder rerun", () => {
  const c = context();
  const bundle = buildArtifact(c, "Read balance", {
    balance: "10",
    computed: {
      kind: "visual",
      control_ref: "data",
      x: 3,
      url: "https://example.org",
    },
    "odd.key": null,
    x: 1,
  });
  const a = parseArtifact(bundle.definition);
  expect(a.steps.map((s) => s.tool)).toEqual([
    "navigate",
    "extract_data",
    "click",
  ]);
  expect(a.steps[1]!.arguments.fields[0].target).toEqual(
    c.records[1]!.input._durable_fields.balance,
  );
  expect(a.steps[2]!.target).toEqual(c.records[2]!.target);
  expect(a.output_mapping.balance).toEqual({
    kind: "step_output",
    step_id: a.steps[1]!.step_id,
    path: "fields.balance.value",
  });
  expect(a.output_mapping.computed.kind).toBe("literal");
  expect(validateValues(a.output_schema, bundle.observed_outputs)).toEqual(
    bundle.observed_outputs,
  );
  expect(a.steps[1]!.arguments).not.toHaveProperty("observation_id");
  expect(a.steps[2]!.arguments).not.toHaveProperty("target");
});
it("keeps reported results when they differ from extraction and preserves failed attempts", () => {
  const c = context();
  c.records[2]!.result = { status: "failed" };
  const bundle = buildArtifact(c, "Read", { balance: "different" });
  expect(bundle.definition.output_mapping.balance).toEqual({
    kind: "literal",
    value: "different",
  });
  expect(bundle.definition.steps).toHaveLength(c.records.length);
});

it("preserves staged visual targets and references using the association on the action record", () => {
  const c = context();
  const visual = {
    kind: "visual" as const,
    asset_id: "crop-handle",
    sha256: "a".repeat(64),
    matcher: "rgb-template-v1" as const,
    threshold: 0.98,
    required_matches: 1 as const,
    relative_point: { u: 0.5, v: 0.5 },
    capture_context: {
      viewport_width: 1280 as const,
      viewport_height: 800 as const,
      device_scale_factor: 1 as const,
      image_scale: "css" as const,
      color_space: "srgb" as const,
    },
  };
  c.records[2]!.input.target = { kind: "point", x: 10, y: 20 };
  c.records[2]!.target = visual;
  c.references = [
    {
      asset_handle: visual.asset_id,
      staged_path: "crop.png",
      sha256: visual.sha256,
      source_call_id: "click",
      crop_rect: { left: 0, top: 10, width: 20, height: 20 },
      relative_point: visual.relative_point,
      capture_context: visual.capture_context,
    },
  ];
  const artifact = buildArtifact(c, "Click", {});
  expect(artifact.definition.steps[2]!.target).toEqual(visual);
  expect(artifact.reference_assets).toEqual(c.references);
  expect(artifact.definition.steps[2]!.arguments).not.toHaveProperty("target");
  expect(artifact.definition.steps[2]!.target).not.toHaveProperty("x");
});

it("preserves every own JSON output key and avoids prototype-sensitive extraction paths", () => {
  const outputs = JSON.parse(
    '{"__proto__":{"__proto__":"nested"},"constructor":"value","prototype":"value","\\u0000key":null}',
  );
  const accepted = finishTaskInput.parse({
    outcome: "goal_achieved",
    summary: "Done",
    outputs,
  });
  expect(accepted.outputs).toEqual(outputs);
  const c = context();
  c.records[1]!.result.fields.constructor = {
    status: "extracted",
    value: "value",
  };
  const artifact = buildArtifact(c, "Read", accepted.outputs!);
  expect(Object.keys(artifact.definition.output_schema.properties)).toEqual(
    Object.keys(outputs),
  );
  expect(Object.keys(artifact.definition.output_mapping)).toEqual(
    Object.keys(outputs),
  );
  expect(artifact.definition.output_mapping.constructor).toEqual({
    kind: "literal",
    value: "value",
  });
  expect(artifact.definition.output_mapping.__proto__.value).toEqual(
    outputs.__proto__,
  );
  expect(validateValues(artifact.definition.output_schema, outputs)).toEqual(
    outputs,
  );
});

it("preserves recorded navigation URLs and observed scope names without adding a completion gate", () => {
  const c = context();
  c.records[0]!.input.url = "https://other.example/path?q=..";
  c.records[2]!.target = {
    ...target("Transactions"),
    scope: [{ role: "region", name: "https://example.org", exact: true }],
  };
  const artifact = buildArtifact(c, "Inspect", {});
  expect(artifact.definition.steps[0]!.arguments.url).toEqual({
    kind: "literal",
    value: c.records[0]!.input.url,
  });
  expect(artifact.definition.steps[2]!.target).toEqual(c.records[2]!.target);
});
