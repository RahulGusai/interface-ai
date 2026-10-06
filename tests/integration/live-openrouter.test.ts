import { it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { runTask } from "../../src/runtime/run-task.js";
import { OpenRouterClient } from "../../src/llm/openrouter-client.js";
import { loadOpenRouterConfig } from "../../src/runtime/config.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { syntheticPolicy } from "../../src/runtime/policy.js";
import { startFixture } from "../helpers/fixture-server.js";
const live =
  process.env.RUN_LIVE_OPENROUTER === "1" &&
  !!process.env.OPENROUTER_API_KEY &&
  !!process.env.OPENROUTER_MODEL;
it.skipIf(!live)(
  "LIVE PAID: configured model reads screenshot-only code and executes browser input",
  async () => {
    const code = "VISUAL-" + randomBytes(3).toString("hex").toUpperCase();
    const fixture = await startFixture(code);
    const config = loadOpenRouterConfig(process.env);
    const client = new OpenRouterClient(config);
    let sawImage = false;
    let issuedCorrectInput = false;
    let completedInput = false;
    try {
      const result = await runTask(
        {
          goal: "Read the code drawn on the canvas, enter that exact code into Member ID, then finish_task. The code exists only in the screenshot.",
          targetUrl: fixture.url,
        },
        {
          policy: syntheticPolicy(fixture.url),
          adapterFactory: createBrowserFactory({ headless: true }),
          model: {
            model: client.model,
            async complete(messages, tools) {
              sawImage ||= messages.some(
                (m) => m.role === "observation" && m.image.bytes.length > 0,
              );
              const turn = await client.complete(messages, tools);
              if (turn.kind === "tool_calls")
                for (const call of turn.calls)
                  if (call.name === "type_text") {
                    try {
                      issuedCorrectInput ||=
                        JSON.parse(call.argumentsJson).text === code;
                    } catch {}
                  }
              return turn;
            },
          },
        },
        {
          maxToolCalls: 8,
          onEvent: (event) => {
            if (
              event.type === "tool_completed" &&
              event.name === "type_text" &&
              event.status === "completed"
            )
              completedInput = true;
          },
        },
      );
      expect(sawImage).toBe(true);
      expect(issuedCorrectInput).toBe(true);
      expect(completedInput).toBe(true);
      expect(result.status).toBe("awaiting_artifact_design");
    } finally {
      await fixture.close();
    }
  },
  180000,
);
