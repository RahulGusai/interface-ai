import { expect, it } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import type { InternalMessage } from "../../src/runtime/history.js";
import type { AuditRecord } from "../../src/runtime/audit.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import { readFileSync } from "node:fs";

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

it.each([undefined, null, [], "string"])(
  "audits invalid completion outputs and sends field feedback",
  async (outputs) => {
    const adapter = makeFakeAdapter(),
      records: AuditRecord[] = [];
    let turn = 0,
      nextHistory: InternalMessage[] = [];
    const result = await runTask(
      { goal: "Inspect", targetUrl: "https://example.org/app" },
      {
        adapterFactory: { createForTask: async () => adapter },
        model: {
          model: "scripted",
          complete: async (history) => {
            if (++turn === 2) nextHistory = history;
            const calls = [
              {
                id: `c${turn}`,
                name: "finish_task",
                argumentsJson: JSON.stringify({
                  outcome: "goal_achieved",
                  summary: "Done",
                  outputs: turn === 1 ? outputs : {},
                  proposal: "malformed",
                  observation_id: "stale",
                  target: { kind: "garbage" },
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
        maxToolCalls: 2,
        onAudit: async (record) => {
          records.push(record);
        },
      },
    );
    const response = nextHistory.find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    );
    if (response?.role !== "tool") throw Error("Missing tool result");
    expect(JSON.parse(response.content)).toMatchObject({
      code: "INVALID_TOOL_CALL",
      message: expect.stringContaining("outputs"),
    });
    expect(
      records.find((r) => r.type === "tool_finished" && r.call.id === "c1"),
    ).toMatchObject({ result: { code: "INVALID_TOOL_CALL" } });
    expect(result.status).toBe("goal_achieved");
    expect(turn).toBe(2);
  },
);

it("builds the artifact after accepted completion is audited, without another capture or model turn", async () => {
  const adapter = makeFakeAdapter(),
    c = discovery();
  let turns = 0;
  const result = await runTask(
    { goal: "Inspect", targetUrl: "https://example.org/app" },
    {
      adapterFactory: { createForTask: async () => adapter },
      contract: { validateOutputs: () => false },
      model: {
        model: "scripted",
        complete: async () => {
          turns++;
          const calls = [
            {
              id: "finish",
              name: "finish_task",
              argumentsJson: JSON.stringify({
                outcome: "goal_achieved",
                summary: "Done",
                outputs: { nested: [null, { x: 2 }] },
                proposal: "malformed",
                observation_id: "stale",
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
      discovery: c,
      onAudit: async (record) => {
        if (record.type === "tool_finished" && record.call.id === "finish") {
          expect(record.result.status).toBe("accepted");
          expect(c.artifact).toBeUndefined();
        }
      },
    },
  );
  expect(result.status).toBe("goal_achieved");
  expect(turns).toBe(1);
  expect(c.artifact?.observed_outputs).toEqual(result.outputs);
  expect(adapter.calls.map((x) => x.name)).toEqual(["navigate"]);
});

it("stops before another action when persisting an accepted completion fails", async () => {
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
                outputs: {},
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

it.each(["null", "{invalid"])(
  "keeps rejected %s arguments out of the artifact action sequence",
  async (bad) => {
    const c = discovery(),
      adapter = makeFakeAdapter();
    let turns = 0;
    const result = await runTask(
      { goal: "Inspect", targetUrl: "https://example.org/app" },
      {
        adapterFactory: { createForTask: async () => adapter },
        model: {
          model: "scripted",
          complete: async () => {
            const first = ++turns === 1;
            const calls = [
              {
                id: `c${turns}`,
                name: first ? "observe_ui" : "finish_task",
                argumentsJson: first
                  ? bad
                  : JSON.stringify({
                      outcome: "goal_achieved",
                      summary: "Done",
                      outputs: {},
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
      { discovery: c },
    );
    expect(result.status).toBe("goal_achieved");
    expect(c.records.map((r) => r.call_id)).toEqual(["bootstrap"]);
    expect(c.artifact?.definition.steps.map((s) => s.tool)).toEqual([
      "navigate",
    ]);
  },
);
