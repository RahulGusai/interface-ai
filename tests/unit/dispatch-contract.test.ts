import { it, expect } from "vitest";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";

it("validates tool arguments without a policy evaluator", async () => {
  const adapter = makeFakeAdapter();
  const context = { adapter, busy: false, halted: false };
  for (const [name, argumentsJson] of [
    ["unknown", "{}"],
    ["click", "{"],
    [
      "press_key",
      '{"observation_id":"o","target":{"kind":"point","x":1,"y":1},"keys":["Enter"]}',
    ],
  ]) {
    const response = await dispatchTool(context, {
      id: "invalid",
      name: name!,
      argumentsJson: argumentsJson!,
    });
    expect(response.result).toMatchObject({
      status: "error",
      code: "INVALID_TOOL_CALL",
    });
  }
  expect(adapter.calls).toHaveLength(0);
  const response = await dispatchTool(context, {
    id: "valid",
    name: "navigate",
    argumentsJson: '{"url":"https://other.example/app"}',
  });
  expect(response.result.status).toBe("completed");
  expect(adapter.calls).toHaveLength(1);
});
