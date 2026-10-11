import { expect, it } from "vitest";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";

it.each(["READ_ONLY", "READ_WRITE"] as const)(
  "unknown effects never dispatch under %s",
  async (accessPolicy) => {
    const adapter = makeFakeAdapter();
    Object.assign(adapter, {
      classifyAction: async () => ({
        category: "unknown",
        reason: "No trusted rule",
      }),
    });
    const capture = await adapter.capture();
    const context = {
      adapter,
      busy: false,
      halted: false,
      accessPolicy,
      allowedHostname: "example.org",
    };
    const result = await dispatchTool(context, {
      id: "x",
      name: "click",
      argumentsJson: JSON.stringify({
        observation_id:
          capture.observation.status === "ok"
            ? capture.observation.observation_id
            : "",
        target: { kind: "control", control_ref: "search" },
      }),
    });
    expect(result.result).toMatchObject({
      status: "policy_blocked",
      code: "ACCESS_POLICY_VIOLATION",
      policy: { access_policy: accessPolicy, category: "unknown" },
    });
    expect(adapter.calls).toHaveLength(0);
    expect(context.halted).toBe(true);
  },
);
it.each([
  "https://sub.example.org",
  "https://example.org.evil.test",
  "https://evil.test",
])("blocks cross-host navigate %s before dispatch", async (url) => {
  const adapter = makeFakeAdapter();
  const context = {
    adapter,
    busy: false,
    halted: false,
    allowedHostname: "example.org",
  };
  const response = await dispatchTool(context, {
    id: "x",
    name: "navigate",
    argumentsJson: JSON.stringify({ url }),
  });
  expect(response.result).toMatchObject({ code: "DOMAIN_POLICY_VIOLATION" });
  expect(adapter.calls).toHaveLength(0);
});
it.each(["READ_ONLY", "READ_WRITE"] as const)(
  "known mutation has one central policy decision under %s",
  async (accessPolicy) => {
    const adapter = makeFakeAdapter();
    Object.assign(adapter, {
      classifyAction: async () => ({
        category: "mutation",
        reason: "Reviewed save handler",
      }),
    });
    const o = (await adapter.capture()).observation;
    if (o.status !== "ok") throw Error();
    const context = {
      adapter,
      busy: false,
      halted: false,
      accessPolicy,
      allowedHostname: "example.org",
    };
    const response = await dispatchTool(context, {
      id: "save",
      name: "click",
      argumentsJson: JSON.stringify({
        observation_id: o.observation_id,
        target: { kind: "control", control_ref: "save" },
      }),
    });
    expect(response.result.status).toBe(
      accessPolicy === "READ_ONLY" ? "policy_blocked" : "completed",
    );
    expect(adapter.calls.length).toBe(accessPolicy === "READ_ONLY" ? 0 : 1);
  },
);

import { runTask } from "../../src/runtime/run-task.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import type { AuditRecord } from "../../src/runtime/audit.js";
it("discovery audits policy rejection, stops the batch, and cannot build an artifact", async () => {
  const adapter = makeFakeAdapter();
  const classify = adapter.classifyAction.bind(adapter);
  Object.assign(adapter, {
    classifyAction: async (action: { name: string }) =>
      action.name === "navigate"
        ? classify()
        : { category: "mutation", reason: "Trusted save handler" },
  });
  const discovery: DiscoveryContext = {
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
    metadata: {
      name: "Inspect",
      description: "Inspect",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      example_inputs: {},
    },
  };
  const audits: AuditRecord[] = [];
  const r = await runTask(
    { goal: "Save", targetUrl: discovery.deployment.base_url },
    {
      adapterFactory: { createForTask: async () => adapter },
      model: {
        model: "scripted",
        async complete() {
          const o = (await adapter.capture()).observation;
          if (o.status !== "ok") throw Error();
          // No durable target recording is needed for a global key action.
          const calls = [
            {
              id: "save",
              name: "press_key",
              argumentsJson: JSON.stringify({
                observation_id: o.observation_id,
                keys: ["Enter"],
              }),
            },
            {
              id: "finish",
              name: "finish_task",
              argumentsJson: JSON.stringify({
                outcome: "goal_achieved",
                summary: "saved",
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
    { discovery, onAudit: (r) => audits.push(r) },
  );
  expect(r).toMatchObject({
    status: "policy_blocked",
    error: { code: "ACCESS_POLICY_VIOLATION" },
  });
  expect(adapter.calls.map((c) => c.name)).toEqual(["navigate"]);
  expect(discovery.artifact).toBeUndefined();
  expect(audits).toContainEqual(
    expect.objectContaining({
      type: "tool_finished",
      result: expect.objectContaining({
        policy: expect.objectContaining({
          access_policy: "READ_ONLY",
          category: "mutation",
          dispatch_state: "not_dispatched",
        }),
      }),
    }),
  );
  expect(audits).toContainEqual(
    expect.objectContaining({
      type: "tool_not_executed",
      calls: [expect.objectContaining({ id: "finish" })],
    }),
  );
});
