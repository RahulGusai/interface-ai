import { it, expect } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
it("awaits durable audit and stops before navigation when the sink fails", async () => {
  let dispatched = 0;
  const result = await runTask(
    { goal: "test", targetUrl: "http://localhost:3000" },
    {
      contract: syntheticContract(),
      model: {
        model: "test",
        complete: async () => {
          throw Error("no model");
        },
      },
      adapterFactory: {
        createForTask: async () => {
          dispatched++;
          throw Error("no adapter");
        },
      },
    },
    {
      onAudit: async () => {
        await Promise.resolve();
        throw Error("storage failed");
      },
    },
  );
  expect(dispatched).toBe(0);
  expect(result.status).toBe("tool_error");
});
it("cancellation before start dispatches nothing", async () => {
  let dispatched = 0;
  const controller = new AbortController();
  controller.abort();
  await runTask(
    { goal: "test", targetUrl: "http://localhost:3000" },
    {
      contract: syntheticContract(),
      model: {
        model: "test",
        complete: async () => {
          throw Error("no model");
        },
      },
      adapterFactory: {
        createForTask: async () => {
          dispatched++;
          throw Error("no adapter");
        },
      },
    },
    { signal: controller.signal },
  );
  expect(dispatched).toBe(0);
});
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
it("discards a provider tool batch that arrives after cancellation", async () => {
  const controller = new AbortController(),
    adapter = makeFakeAdapter();
  let release: (value: any) => void = () => {};
  let entered: () => void = () => {};
  const begun = new Promise<void>((r) => (entered = r));
  const running = runTask(
    { goal: "test", targetUrl: "http://localhost:3000" },
    {
      contract: syntheticContract(),
      adapterFactory: { createForTask: async () => adapter },
      model: {
        model: "fake",
        complete: async () => {
          entered();
          return await new Promise((r) => (release = r));
        },
      },
    },
    { signal: controller.signal },
  );
  await begun;
  controller.abort();
  const calls = [
    {
      id: "late",
      name: "observe_ui",
      argumentsJson: JSON.stringify({ mode: "both" }),
    },
  ];
  release({
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: null, tool_calls: calls },
  });
  await running;
  expect(adapter.calls.map((c) => c.name)).toEqual(["navigate"]);
  expect(adapter.closed).toBe(true);
});
