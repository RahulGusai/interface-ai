import { it, expect } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import { startFixture } from "../helpers/fixture-server.js";
import type { AgentTurn } from "../../src/contracts/run.js";
import type { InternalMessage } from "../../src/runtime/history.js";
import type { Observation } from "../../src/contracts/observation.js";
import type { ModelClient } from "../../src/llm/model-client.js";
import { scriptedModel } from "../../src/demo/scripted-model.js";
it("scripted model + real Chromium delivers first/later images and matching tool results", async () => {
  const fixture = await startFixture();
  const script = scriptedModel();
  let requests = 0;
  const events: string[] = [];
  try {
    const result = await runTask(
      { goal: "Find member 42", targetUrl: fixture.url },
      {
        contract: syntheticContract(),
        adapterFactory: createBrowserFactory({ headless: true }),
        model: {
          model: script.model,
          async complete(messages, tools) {
            requests++;
            expect(tools).toHaveLength(12);
            expect(
              messages.some(
                (m) => m.role === "observation" && m.image.bytes.length > 0,
              ),
            ).toBe(true);
            if (requests === 4)
              expect(
                JSON.stringify(messages.filter((m) => m.role === "tool")),
              ).toContain("Member Ada | 123.50");
            return script.complete(messages, tools);
          },
        },
      },
      { maxToolCalls: 8, onEvent: (e) => events.push(e.type) },
    );
    expect(result.status).toBe("goal_achieved");
    expect(result.toolCallsUsed).toBe(4);
    expect(requests).toBe(4);
    expect(events.filter((e) => e === "tool_completed")).toHaveLength(4);
  } finally {
    await fixture.close();
  }
});
