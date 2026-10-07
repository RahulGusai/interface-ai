import { it, expect } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import type { AgentTurn, ToolCall } from "../../src/contracts/run.js";
import type { InternalMessage } from "../../src/runtime/history.js";
const input = { goal: "Find member", targetUrl: "https://example.org/app" };
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
              }
            : { observation_id: "obs_1", reason: "stuck", message: "help" },
        ),
      ]),
    ]);
    const r = await runTask(input, s.deps, { maxToolCalls: 1 });
    expect(r.status).toBe(
      name === "finish_task"
        ? "awaiting_artifact_design"
        : "needs_intervention",
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
