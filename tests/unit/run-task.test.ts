import { it, expect } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import type { AgentTurn, ToolCall } from "../../src/contracts/run.js";
import type { InternalMessage } from "../../src/runtime/history.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
import { OpenRouterClient } from "../../src/llm/openrouter-client.js";
import { SafeError } from "../../src/contracts/errors.js";
const input = { goal: "Find member", targetUrl: "https://example.org/app" };
it("preserves and audits metadata provider failures before opening a browser", async () => {
  const s = setup([]);
  const audits: any[] = [];
  const result = await runTask(
    input,
    {
      ...s.deps,
      model: {
        ...s.deps.model,
        async generateCapability() {
          throw new SafeError(
            "PROVIDER_HTTP",
            "Provider request failed (HTTP 429)",
          );
        },
      },
    },
    {
      discovery: {
        deployment: {
          app_deployment_id: "test",
          base_url: input.targetUrl,
          product_id: "desk",
          ui_variant: "standard",
          vendor_release: null,
          config_version: 1,
        },
        capability_catalog: [],
        inputs: {},
        records: [],
        references: [],
      },
      onAudit: (record) => {
        audits.push(record);
      },
    },
  );
  expect(result.error).toEqual({
    code: "PROVIDER_HTTP",
    message: "Provider request failed (HTTP 429)",
  });
  expect(audits).toContainEqual(
    expect.objectContaining({
      type: "provider_failed",
      modelTurn: 0,
      stage: "capability_metadata",
      error: result.error,
    }),
  );
  expect(s.adapters).toHaveLength(0);
});
const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  name,
  argumentsJson: JSON.stringify(args),
});
const batch = (calls: ToolCall[]): AgentTurn => ({
  kind: "tool_calls",
  calls,
  assistantMessage: { role: "assistant", content: null, tool_calls: calls },
});
function setup(
  turns: (AgentTurn | ((history: InternalMessage[]) => AgentTurn))[],
) {
  const adapters: ReturnType<typeof makeFakeAdapter>[] = [];
  const requests: InternalMessage[][] = [];
  return {
    adapters,
    requests,
    deps: {
      contract: syntheticContract(),
      adapterFactory: {
        async createForTask() {
          const a = makeFakeAdapter();
          adapters.push(a);
          return a;
        },
      },
      model: {
        model: "fake-model",
        async complete(h: InternalMessage[]) {
          requests.push([...h]);
          const next = turns.shift();
          if (!next) throw new Error("exhausted");
          return typeof next === "function" ? next(h) : next;
        },
      },
    },
  };
}
it("discovery rejects a stale retry after capture failure and recovers by observing without another click", async () => {
  const adapter = makeFakeAdapter();
  const execute = adapter.execute.bind(adapter);
  const recoveringAdapter = {
    ...adapter,
    async execute(
      action: Parameters<typeof execute>[0],
    ): Promise<ToolResponse> {
      const response = await execute(action);
      if (action.name === "click") {
        return {
          result: {
            status: "uncertain",
            observation: {
              status: "error",
              code: "CAPTURE_FAILED",
              message: "Fresh observation unavailable",
              retryable: true,
            },
          },
        };
      }
      const observation =
        "observation" in response.result
          ? response.result.observation
          : response.result;
      if (observation.status === "ok") {
        observation.controls = {
          status: "available",
          items: [
            {
              ref: "search",
              role: "button",
              name: "Search",
              state: { enabled: true },
            },
          ],
        };
      }
      return response;
    },
  };
  const turns = [
    batch([
      call("search", "click", {
        observation_id: "obs_1",
        target: { kind: "control", control_ref: "search" },
      }),
    ]),
    batch([
      call("retry", "click", {
        observation_id: "obs_1",
        target: { kind: "control", control_ref: "search" },
      }),
    ]),
    batch([call("fresh", "observe_ui", { mode: "both" })]),
    {
      kind: "final_text" as const,
      text: "Stopped",
      assistantMessage: { role: "assistant" as const, content: "Stopped" },
    },
  ];
  const audits: any[] = [];
  const histories: InternalMessage[][] = [];
  const discovery: DiscoveryContext = {
    deployment: {
      app_deployment_id: "test",
      base_url: input.targetUrl,
      product_id: "desk",
      ui_variant: "standard",
      vendor_release: null,
      config_version: 1,
    },
    capability_catalog: [],
    inputs: {},
    metadata: {
      name: "Find member",
      description: "Find a member",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      example_inputs: {},
    },
    records: [],
    references: [],
  };
  const result = await runTask(
    input,
    {
      adapterFactory: {
        async createForTask() {
          return recoveringAdapter;
        },
      },
      model: {
        model: "fake",
        async complete(history) {
          histories.push([...history]);
          return turns.shift()!;
        },
      },
    },
    {
      discovery,
      onAudit: async (record) => {
        audits.push(record);
      },
    },
  );
  expect(result.status).toBe("agent_stopped_unverified");
  expect(adapter.calls.map((c) => c.name)).toEqual([
    "navigate",
    "click",
    "observe_ui",
  ]);
  expect(
    audits.find((r) => r.type === "tool_finished" && r.call.id === "retry")
      ?.result,
  ).toMatchObject({ status: "error", code: "STALE_OBSERVATION" });
  expect(
    histories[2]?.find((m) => m.role === "tool" && m.tool_call_id === "retry"),
  ).toMatchObject({ content: expect.stringContaining("STALE_OBSERVATION") });
  expect(discovery.records.map((r) => r.call_id)).toEqual([
    "bootstrap",
    "search",
    "fresh",
  ]);
  expect(adapter.closed).toBe(true);
});
it("backend discovery needs no policy and bootstraps the deployment URL before clicking", async () => {
  const s = setup([
    batch([
      call("customer-search", "click", {
        observation_id: "obs_1",
        target: { kind: "control", control_ref: "customer-search" },
      }),
    ]),
    {
      kind: "final_text",
      text: "Stopped",
      assistantMessage: { role: "assistant", content: "Stopped" },
    },
  ]);
  const r = await runTask(input, s.deps);
  expect(r.status).toBe("agent_stopped_unverified");
  expect(s.adapters[0]?.calls).toMatchObject([
    { name: "navigate", input: { url: input.targetUrl } },
    { name: "click" },
  ]);
  expect(s.requests).toHaveLength(2);
  expect(s.adapters[0]?.closed).toBe(true);
});
it("rejects oversized batches before execution, does not count bootstrap, closes one adapter", async () => {
  const s = setup([
    batch([
      call("1", "observe_ui", { mode: "both" }),
      call("2", "observe_ui", { mode: "both" }),
    ]),
  ]);
  const result = await runTask(input, s.deps, { maxToolCalls: 1 });
  expect(result.status).toBe("max_tool_calls_reached");
  expect(result.toolCallsUsed).toBe(0);
  expect(s.adapters[0]?.calls.map((x) => x.name)).toEqual(["navigate"]);
  expect(s.adapters[0]?.closed).toBe(true);
  expect(s.requests).toHaveLength(1);
});
it("counts invalid proposals and preserves assistant/tool order and matching IDs", async () => {
  const s = setup([
    batch([
      call("a", "unknown", {}),
      call("b", "observe_ui", { mode: "both" }),
    ]),
    {
      kind: "final_text",
      text: "done",
      assistantMessage: { role: "assistant", content: "done" },
    },
  ]);
  const r = await runTask(input, s.deps, { maxToolCalls: 3 });
  expect(r.status).toBe("agent_stopped_unverified");
  expect(r.toolCallsUsed).toBe(2);
  expect(
    s.requests[1]
      ?.filter((m) => m.role === "tool")
      .map((m) => ("tool_call_id" in m ? m.tool_call_id : "")),
  ).toEqual(["a", "b"]);
  expect(s.adapters).toHaveLength(1);
});
it("processes last-slot finish honestly and request_human stops batch", async () => {
  for (const name of ["finish_task", "request_human"]) {
    const s = setup([
      batch([
        call(
          "a",
          name,
          name === "finish_task"
            ? {
                observation_id: "obs_1",
                outcome: "goal_achieved",
                summary: "done",
                outputs: {},
              }
            : { observation_id: "obs_1", reason: "stuck", message: "help" },
        ),
      ]),
    ]);
    const r = await runTask(input, s.deps, { maxToolCalls: 1 });
    expect(r.status).toBe(
      name === "finish_task" ? "goal_achieved" : "needs_intervention",
    );
    expect(r.toolCallsUsed).toBe(1);
    expect(s.adapters[0]?.closed).toBe(true);
  }
});
it("stops before next model call at budget and isolates invocations", async () => {
  const s = setup([
    batch([call("a", "observe_ui", { mode: "both" })]),
    batch([call("a", "observe_ui", { mode: "both" })]),
  ]);
  for (let i = 0; i < 2; i++)
    expect((await runTask(input, s.deps, { maxToolCalls: 1 })).status).toBe(
      "max_tool_calls_reached",
    );
  expect(s.adapters).toHaveLength(2);
  expect(s.requests).toHaveLength(2);
});
it("opens the supplied URL and closes the adapter on provider error", async () => {
  const s = setup([]);
  const targetUrl = "https://other.example/app";
  expect((await runTask({ ...input, targetUrl }, s.deps)).status).toBe(
    "provider_error",
  );
  expect(s.adapters[0]?.calls[0]).toMatchObject({
    name: "navigate",
    input: { url: targetUrl },
  });
  expect(s.adapters[0]?.closed).toBe(true);
});
it("persists the specific safe provider failure after a stale result", async () => {
  const s = setup([
    batch([
      call("stale", "click", {
        observation_id: "old",
        target: { kind: "control", control_ref: "c1" },
      }),
    ]),
  ]);
  let turn = 0;
  const scripted = s.deps.model;
  const client = new OpenRouterClient(
    { apiKey: "SECRET", model: "test" },
    async () => new Response("SECRET", { status: 429 }),
  );
  const audit: any[] = [];
  const result = await runTask(
    input,
    {
      ...s.deps,
      model: {
        model: "test",
        async complete(history, tools, options) {
          return turn++ === 0
            ? scripted.complete(history)
            : client.complete(history, tools, options);
        },
      },
    },
    {
      onAudit: async (record) => {
        audit.push(record);
      },
    },
  );
  expect(result.status).toBe("provider_error");
  expect(result.error).toEqual({
    code: "PROVIDER_HTTP",
    message: "Provider request failed (HTTP 429)",
  });
  expect(audit.find((r) => r.type === "provider_failed")).toMatchObject({
    modelTurn: 2,
    error: result.error,
  });
  expect(JSON.stringify(audit)).not.toContain("SECRET");
  expect(s.adapters[0]?.calls.map((c) => c.name)).toEqual(["navigate"]);
});
it("sequential stale dependent references never reach browser", async () => {
  const s = setup([
    batch([
      call("a", "click", {
        observation_id: "obs_1",
        target: { kind: "control", control_ref: "c1" },
      }),
      call("b", "click", {
        observation_id: "obs_1",
        target: { kind: "control", control_ref: "c1" },
      }),
    ]),
  ]);
  expect(
    (await runTask(input, s.deps, { maxToolCalls: 2 })).toolCallsUsed,
  ).toBe(2);
  expect(s.adapters[0]?.calls.map((x) => x.name)).toEqual([
    "navigate",
    "click",
  ]);
});
it("passes task context to the provider without policy redaction", async () => {
  const s = setup([
    {
      kind: "final_text",
      text: "done",
      assistantMessage: { role: "assistant", content: "done" },
    },
  ]);
  await runTask({ ...input, goal: "Find PRIVATE_MARKER" }, s.deps);
  expect(JSON.stringify(s.requests)).toContain("PRIVATE_MARKER");
});
it("reports the reason for an accepted human request", async () => {
  const s = setup([
    batch([
      call("a", "request_human", {
        observation_id: "obs_1",
        reason: "ambiguous_state",
        message: "Two matching members need review",
      }),
    ]),
  ]);
  const events: unknown[] = [];
  const result = await runTask(input, s.deps, {
    onEvent: (event) => events.push(event),
  });
  expect(result.summary).toBe("Two matching members need review");
  expect(events).toContainEqual({
    type: "intervention_requested",
    reason: "Two matching members need review",
  });
});
it("retries an empty provider turn without replaying browser actions or altering history", async () => {
  const fail = () => {
    throw new SafeError("PROVIDER_EMPTY_RESPONSE", "Empty provider response");
  };
  const s = setup([
    fail,
    batch([
      call("done", "finish_task", {
        outcome: "goal_achieved",
        summary: "Done",
        outputs: {},
      }),
    ]),
  ]);
  const audits: any[] = [];
  const result = await runTask(
    input,
    { ...s.deps, contract: {} },
    {
      onAudit: (r) => {
        audits.push(r);
      },
    },
  );
  expect(result.status).toBe("goal_achieved");
  expect(s.requests).toHaveLength(2);
  expect(s.requests[0]).toEqual(s.requests[1]);
  expect(audits.filter((r) => r.type === "provider_retry")).toHaveLength(1);
  expect(
    audits.filter((r) => r.type === "tool_started" && r.source === "bootstrap"),
  ).toHaveLength(1);
});
it("bounds empty-response retries and retains the terminal diagnostic", async () => {
  const fail = () => {
    throw new SafeError("PROVIDER_EMPTY_RESPONSE", "Empty provider response");
  };
  const s = setup([fail, fail, fail, fail]);
  const result = await runTask(input, s.deps);
  expect(result.status).toBe("provider_error");
  expect(result.error?.code).toBe("PROVIDER_EMPTY_RESPONSE");
  expect(s.requests).toHaveLength(3);
});
