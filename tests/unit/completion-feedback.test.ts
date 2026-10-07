import { expect, it } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import type { InternalMessage } from "../../src/runtime/history.js";
import type { AuditRecord } from "../../src/runtime/audit.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import { readFileSync } from "node:fs";

const definition = JSON.parse(
  readFileSync(
    new URL("../fixtures/replay-member-desk/artifact.json", import.meta.url),
    "utf8",
  ),
);
const proposal = () => ({
  proposal_version: 1,
  capability_selection: {
    mode: "new",
    name: "Member status",
    description: "Read status",
    reason: "No catalog operation",
    input_schema: structuredClone(definition.input_schema),
    output_schema: structuredClone(definition.output_schema),
  },
  parameter_values: { email: "demo@example.test" },
  observed_outputs: { status: "Active" },
  definition: structuredClone(definition),
  reference_assets: [],
});
const discovery = (): DiscoveryContext => ({
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
  records: [],
  references: [],
});

it("returns schema paths for invalid tool arguments without echoing input values", async () => {
  const adapter = makeFakeAdapter();
  const response = await dispatchTool(
    { adapter, busy: false, halted: false },
    {
      id: "bad",
      name: "press_key",
      argumentsJson: JSON.stringify({
        observation_id: "o",
        target: { kind: "point", x: 1, y: 1 },
        keys: ["Enter"],
        secret: "SENTINEL_SECRET",
      }),
    },
  );
  expect(response.result).toMatchObject({
    status: "error",
    code: "INVALID_TOOL_CALL",
    message: expect.stringContaining("target.kind"),
  });
  expect(JSON.stringify(response)).not.toContain("SENTINEL_SECRET");
  expect(adapter.calls).toHaveLength(0);
});

it.each(["missing", "schema", "stale"] as const)(
  "audits %s discovery proposal rejection and returns repair feedback to the next model turn",
  async (kind) => {
    const adapter = makeFakeAdapter(),
      records: AuditRecord[] = [];
    const p = proposal();
    if (kind === "schema")
      delete p.capability_selection.input_schema.additionalProperties;
    if (kind === "stale") p.definition.steps[0].arguments.control_ref = "c23";
    let turn = 0;
    let nextHistory: InternalMessage[] = [];
    await runTask(
      { goal: "Inspect", targetUrl: "https://example.org/app" },
      {
        adapterFactory: { createForTask: async () => adapter },
        model: {
          model: "scripted",
          complete: async (history: InternalMessage[]) => {
            const id = `c${++turn}`;
            if (turn === 2) nextHistory = history;
            const args =
              turn === 1
                ? {
                    observation_id: "obs_1",
                    outcome: "goal_achieved",
                    summary: "SENTINEL_SECRET",
                    ...(kind === "missing" ? {} : { proposal: p }),
                  }
                : { mode: "both" };
            const calls = [
              {
                id,
                name: turn === 1 ? "finish_task" : "observe_ui",
                argumentsJson: JSON.stringify(args),
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
        discovery: discovery(),
        maxToolCalls: 2,
        onAudit: async (record) => {
          records.push(record);
        },
      },
    );
    const response = nextHistory.find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    );
    expect(response?.role).toBe("tool");
    if (response?.role !== "tool") throw Error("Missing result");
    const result = JSON.parse(response.content);
    expect(result.code).toBe(
      kind === "schema" ? "INVALID_TOOL_CALL" : "DURABLE_PROPOSAL_INVALID",
    );
    expect(result.message).toContain(
      kind === "schema"
        ? "proposal.capability_selection.input_schema.additionalProperties"
        : kind === "missing"
          ? "proposal"
          : "STALE_ARTIFACT_FIELD",
    );
    expect(result.message).toMatch(/repair|correct|replace|supply/i);
    const audited = records.find(
      (r) => r.type === "tool_finished" && r.call.id === "c1",
    );
    expect(audited).toMatchObject({ result });
    expect(
      records.filter((r) => r.type === "tool_started").map((r) => r.call.id),
    ).toEqual(["bootstrap", "c1", "c2"]);
    const finished = records.filter((r) => r.type === "tool_finished");
    expect(finished.map((r) => r.call.id)).toEqual(["bootstrap", "c1", "c2"]);
    expect(JSON.stringify(finished[1]?.result)).not.toContain(
      "SENTINEL_SECRET",
    );
  },
);

it("stops before another action when persisting a completion rejection fails", async () => {
  const adapter = makeFakeAdapter();
  let models = 0;
  const result = await runTask(
    { goal: "Inspect", targetUrl: "https://example.org/app" },
    {
      adapterFactory: { createForTask: async () => adapter },
      model: {
        model: "scripted",
        complete: async () => {
          models++;
          const calls = [
            {
              id: "finish",
              name: "finish_task",
              argumentsJson: JSON.stringify({
                observation_id: "obs_1",
                outcome: "goal_achieved",
                summary: "Done",
              }),
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
      discovery: discovery(),
      onAudit: async (record) => {
        if (record.type === "tool_finished" && record.call.id === "finish")
          throw Error("disk full");
      },
    },
  );
  expect(result.status).toBe("tool_error");
  expect(models).toBe(1);
  expect(adapter.calls.map((c) => c.name)).toEqual(["navigate"]);
});
