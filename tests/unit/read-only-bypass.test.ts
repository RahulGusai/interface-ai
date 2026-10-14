import { expect, it } from "vitest";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import { runTask } from "../../src/runtime/run-task.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";

it.each([
  undefined,
  { decision: "requires_human_review", confidence: 0, reason: "x" },
  { invalid: true },
])(
  "READ_ONLY executes without classification or review for assessment %j",
  async (execution) => {
    const adapter = makeFakeAdapter();
    adapter.classifyAction = async () => {
      throw Error("Classification must not run");
    };
    const o = (await adapter.capture()).observation;
    if (o.status !== "ok") throw Error();
    const context = {
      adapter,
      accessPolicy: "READ_ONLY" as const,
      busy: false,
      halted: false,
      review: async () => {
        throw Error("Review must not run");
      },
    };
    const response = await dispatchTool(context, {
      id: "search",
      name: "click",
      argumentsJson: JSON.stringify({
        observation_id: o.observation_id,
        target: { kind: "control", control_ref: "search" },
        execution,
      }),
    });
    expect(response.result.status).toBe("completed");
    expect(adapter.calls[0]).toMatchObject({
      name: "click",
      input: { target: { control_ref: "search" } },
    });
    expect(context.halted).toBe(false);
  },
);

it("READ_ONLY navigation bypasses the deployment hostname gate", async () => {
  const adapter = makeFakeAdapter();
  const response = await dispatchTool(
    {
      adapter,
      accessPolicy: "READ_ONLY",
      allowedHostname: "example.org",
      busy: false,
      halted: false,
    },
    {
      id: "navigate",
      name: "navigate",
      argumentsJson: JSON.stringify({
        url: "https://other.example.test/profile",
      }),
    },
  );
  expect(response.result.status).toBe("completed");
  expect(adapter.calls[0]).toMatchObject({
    input: { url: "https://other.example.test/profile" },
  });
});

it.each([false, true])(
  "READ_ONLY model calls omit assessment requirements (discovery=%s)",
  async (discoveryMode) => {
    const discovery: DiscoveryContext = {
      deployment: {
        app_deployment_id: "test",
        base_url: "https://example.org/app",
        product_id: "test",
        ui_variant: "classic",
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
    const result = await runTask(
      {
        goal: "Inspect",
        targetUrl: "https://example.org/app",
        accessPolicy: "READ_ONLY",
      },
      {
        adapterFactory: { createForTask: async () => makeFakeAdapter() },
        model: {
          model: "scripted",
          async complete(messages, definitions) {
            for (const d of definitions) {
              expect(
                (d.function.parameters as any).required ?? [],
              ).not.toContain("execution");
              expect(
                (d.function.parameters as any).properties,
              ).not.toHaveProperty("execution");
            }
            const system = messages[0];
            if (system?.role !== "system") throw Error("Missing system prompt");
            expect(system.content).not.toContain(
              "For EVERY proposed tool call include execution",
            );
            expect(system.content).not.toContain(
              "Page navigation must remain on exact hostname",
            );
            return {
              kind: "final_text",
              text: "Done",
              assistantMessage: { role: "assistant", content: "Done" },
            };
          },
        },
      },
      discoveryMode ? { discovery } : {},
    );
    expect(result.status).toBe("agent_stopped_unverified");
  },
);
