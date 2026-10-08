import { expect, it } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import type { InternalMessage } from "../../src/runtime/history.js";

const discovery = (): DiscoveryContext => ({
  deployment: {
    app_deployment_id: "test",
    base_url: "https://example.org",
    product_id: "test",
    ui_variant: "classic",
    vendor_release: null,
    config_version: 1,
  },
  inputs: {},
  capability_catalog: [],
  records: [],
  references: [],
});
const metadata = {
  name: "Find account",
  description: "Find an account and read its number",
  input_schema: {
    type: "object" as const,
    properties: { account_suffix: { type: "string" as const } },
    required: ["account_suffix"],
    additionalProperties: false as const,
  },
  example_inputs: { account_suffix: "7106" },
};
const extraction = (ref: string) => ({
  observation_id: "obs_1",
  fields: [
    {
      name: "account_number",
      target: { kind: "control", control_ref: ref },
      property: "text",
      output_type: "string",
    },
  ],
});

async function run(proposals: { name: string; args: unknown }[]) {
  const adapter = makeFakeAdapter();
  const execute = adapter.execute.bind(adapter);
  adapter.capabilities.add("extract_data");
  adapter.capabilities.add("type_text");
  const context = discovery();
  const audits: any[] = [];
  const histories: InternalMessage[][] = [];
  const definitions: any[] = [];
  const result = await runTask(
    { goal: "Read the account ending 7106", targetUrl: "https://example.org" },
    {
      adapterFactory: {
        createForTask: async () => ({
          ...adapter,
          async execute(action) {
            const response = await execute(action);
            const observation =
              "observation" in response.result
                ? response.result.observation
                : response.result;
            if (observation.status === "ok")
              observation.controls = {
                status: "available",
                items: [
                  {
                    ref: "dynamic",
                    role: "text",
                    name: "012-9637106",
                    text: "012-9637106",
                    state: {},
                  },
                  {
                    ref: "stable",
                    role: "text",
                    name: "Account number",
                    text: "012-9637106",
                    state: {},
                  },
                  {
                    ref: "search",
                    role: "textbox",
                    name: "Account suffix",
                    state: {},
                  },
                ],
              };
            if (action.name === "extract_data")
              return {
                result: {
                  ...response.result,
                  fields: {
                    account_number: {
                      status: "extracted" as const,
                      value: "012-9637106",
                    },
                  },
                },
              };
            if (action.name === "type_text")
              return {
                result: {
                  ...response.result,
                  verification: "matched" as const,
                },
              };
            return response;
          },
        }),
      },
      model: {
        model: "scripted",
        generateCapability: async () => metadata,
        async complete(history, tools, options) {
          definitions.push(tools);
          expect(options?.toolChoice).toBe("required");
          histories.push([...history]);
          const next = proposals.shift();
          if (!next) throw Error("Unexpected extra model turn");
          const calls = [
            {
              id: `call_${histories.length}`,
              name: next.name,
              argumentsJson: JSON.stringify(next.args),
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
      },
    },
    {
      discovery: context,
      onAudit: (event) => {
        audits.push(event);
      },
    },
  );
  return { result, adapter, context, audits, histories, definitions };
}

it("reports the rejected extraction target and allows a corrected labeled source", async () => {
  const s = await run([
    { name: "extract_data", args: extraction("dynamic") },
    { name: "extract_data", args: extraction("stable") },
    {
      name: "finish_task",
      args: {
        outcome: "goal_achieved",
        summary: "Read account",
        outputs: { account_number: "012-9637106" },
      },
    },
  ]);
  const rejected = s.audits.find(
    (e) => e.type === "tool_finished" && e.call.id === "call_1",
  );
  expect(rejected.result).toMatchObject({
    code: "TARGET_DEPENDS_ON_INPUT",
    message: expect.stringContaining("fields.0.target"),
  });
  expect(rejected.result.message).toContain("stable label");
  expect(rejected.result.message).not.toContain("7106");
  expect(s.adapter.calls.filter((c) => c.name === "extract_data")).toHaveLength(
    1,
  );
  expect(s.result.status).toBe("goal_achieved");
  expect(s.histories[0]?.[0]).toMatchObject({
    role: "system",
    content: expect.stringContaining('"path":"account_suffix"'),
  });
  expect(s.histories[0]?.filter((m) => m.role === "system")).toHaveLength(1);
  const extractionSchema = s.definitions[0].find(
    (d: any) => d.function.name === "extract_data",
  ).function.parameters;
  expect(
    extractionSchema.properties.fields.items.properties.row_match,
  ).toBeDefined();
  expect(
    JSON.stringify(
      extractionSchema.properties.fields.items.properties.row_match,
    ),
  ).toContain("ends_with");
  expect(
    s.definitions[0].find((d: any) => d.function.name === "type_text").function
      .parameters.properties.text.description,
  ).toContain("account_suffix");
  expect(
    s.context.artifact?.definition.output_mapping.account_number,
  ).toMatchObject({ kind: "step_output" });
});

it("stops an unchanged rejected extraction instead of continuing the loop", async () => {
  const s = await run([
    { name: "extract_data", args: extraction("dynamic") },
    // Key ordering does not constitute a correction.
    {
      name: "extract_data",
      args: { fields: extraction("dynamic").fields, observation_id: "obs_1" },
    },
  ]);
  expect(s.result).toMatchObject({
    status: "tool_error",
    error: { code: "REPEATED_INVALID_EXTRACTION" },
  });
  expect(s.result.summary).toContain("stable label");
  expect(s.histories).toHaveLength(2);
  expect(s.adapter.calls.map((c) => c.name)).toEqual(["navigate"]);
  expect(s.context.artifact).toBeUndefined();
});

it("rejects literal variable arguments before dispatch and accepts explicit bindings", async () => {
  const args = {
    observation_id: "obs_1",
    target: { kind: "control", control_ref: "search" },
    text: "7106",
    mode: "replace",
  };
  const s = await run([
    { name: "type_text", args },
    {
      name: "type_text",
      args: { ...args, text: { kind: "input", path: "account_suffix" } },
    },
    {
      name: "finish_task",
      args: {
        outcome: "goal_achieved",
        summary: "Entered account suffix",
        outputs: {},
        row_match: { ignored_extra: "7106" },
      },
    },
  ]);
  expect(
    s.audits.find((e) => e.type === "tool_finished" && e.call.id === "call_1")
      .result,
  ).toMatchObject({
    code: "UNBOUND_INPUT_ARGUMENT",
    message: expect.stringContaining("text"),
  });
  expect(s.adapter.calls.filter((c) => c.name === "type_text")).toHaveLength(1);
  expect(s.result.status).toBe("goal_achieved");
  expect(s.context.artifact?.definition.steps[1]?.arguments.text).toEqual({
    kind: "input",
    path: "account_suffix",
  });
  expect(
    s.audits.find((e) => e.type === "capability_metadata_generated"),
  ).toMatchObject({ metadata, inputs: { account_suffix: "7106" } });
  const system = s.histories[0]?.find(
    (m) => m.role === "system" && m.content.includes("capability_metadata"),
  );
  expect(system && "content" in system ? system.content : "").toContain(
    "account_suffix",
  );
});
