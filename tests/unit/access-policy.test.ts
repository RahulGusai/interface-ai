import { expect, it } from "vitest";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";

it.each(["READ_ONLY", "READ_WRITE"] as const)(
  "unknown effects without assessment use the selected policy %s",
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
    expect(result.result).toMatchObject(
      accessPolicy === "READ_WRITE"
        ? { status: "error", code: "HUMAN_REVIEW_UNAVAILABLE" }
        : { status: "completed" },
    );
    expect(adapter.calls).toHaveLength(accessPolicy === "READ_ONLY" ? 1 : 0);
    expect(context.halted).toBe(accessPolicy === "READ_WRITE");
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
    accessPolicy: "READ_WRITE" as const,
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
  "auto-approved calls execute under %s",
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
        execution: {
          decision: "auto_approve",
          confidence: 0.3,
          reason: "Synthetic test",
        },
      }),
    });
    expect(response.result.status).toBe("completed");
    expect(adapter.calls.length).toBe(1);
  },
);

import { runTask } from "../../src/runtime/run-task.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import type { AuditRecord } from "../../src/runtime/audit.js";
it("READ_WRITE discovery audits domain rejection, stops the batch, and cannot build an artifact", async () => {
  const adapter = makeFakeAdapter();
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
    {
      goal: "Inspect",
      targetUrl: discovery.deployment.base_url,
      accessPolicy: "READ_WRITE",
    },
    {
      adapterFactory: { createForTask: async () => adapter },
      model: {
        model: "scripted",
        async complete() {
          const o = (await adapter.capture()).observation;
          if (o.status !== "ok") throw Error();
          // Domain rejection precedes assessment review and dispatch.
          const calls = [
            {
              id: "save",
              name: "navigate",
              argumentsJson: JSON.stringify({
                url: "https://elsewhere.example.test",
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
    error: { code: "DOMAIN_POLICY_VIOLATION" },
  });
  expect(adapter.calls.map((c) => c.name)).toEqual(["navigate"]);
  expect(discovery.artifact).toBeUndefined();
  expect(audits).toContainEqual(
    expect.objectContaining({
      type: "tool_finished",
      result: expect.objectContaining({
        policy: expect.objectContaining({
          access_policy: "READ_WRITE",
          category: "unknown",
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
