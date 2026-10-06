import { parseArgs } from "node:util";
import { runTask } from "../runtime/run-task.js";
import { loadOpenRouterConfig } from "../runtime/config.js";
import { OpenRouterClient } from "../llm/openrouter-client.js";
import { createBrowserFactory } from "../adapters/factory.js";
import { RuntimePolicy, syntheticPolicy } from "../runtime/policy.js";
import { startFixture } from "../../tests/helpers/fixture-server.js";
import type { ToolName } from "../contracts/tools.js";
async function main() {
  const { values } = parseArgs({
    options: {
      goal: { type: "string" },
      url: { type: "string" },
      synthetic: { type: "boolean" },
      "max-tool-calls": { type: "string" },
      "allow-writes": { type: "boolean" },
      "allow-screenshots": { type: "boolean" },
      "path-prefix": { type: "string" },
      headless: { type: "boolean" },
    },
  });
  if (!values.goal || (!values.url && !values.synthetic))
    throw new Error("Supply --goal and --url, or --goal and --synthetic");
  const config = loadOpenRouterConfig(process.env);
  const fixture = values.synthetic ? await startFixture() : undefined;
  try {
    const url = fixture?.url ?? values.url!;
    const origin = new URL(url).origin;
    const reads: ToolName[] = [
      "observe_ui",
      "navigate",
      "check_ui",
      "wait_for",
      "extract_data",
      "request_human",
      "finish_task",
    ];
    const policy = fixture
      ? syntheticPolicy(url)
      : new RuntimePolicy({
          documents: [{ origin, pathPrefix: values["path-prefix"] ?? "/" }],
          resourceOrigins: [origin],
          allowedActions: values["allow-writes"]
            ? [
                ...reads,
                "click",
                "type_text",
                "press_key",
                "scroll",
                "select_option",
              ]
            : reads,
          allowScreenshots: !!values["allow-screenshots"],
          riskyAction: (action) =>
            action.name === "navigate" || values["allow-writes"]
              ? "allow"
              : "intervention",
        });
    const result = await runTask(
      { goal: values.goal, targetUrl: url },
      {
        model: new OpenRouterClient(config),
        policy,
        adapterFactory: createBrowserFactory({
          headless: !!values.headless,
          slowMo: values.headless ? 0 : 100,
        }),
      },
      {
        maxToolCalls:
          values["max-tool-calls"] === undefined
            ? undefined
            : Number(values["max-tool-calls"]),
        onEvent: (event) => {
          if (
            event.type === "tool_completed" ||
            event.type === "model_turn" ||
            event.type === "intervention_requested"
          )
            console.log(JSON.stringify(event));
        },
      },
    );
    console.log(JSON.stringify(result));
    if (
      ["provider_error", "tool_error", "policy_blocked"].includes(result.status)
    )
      process.exitCode = 1;
  } finally {
    await fixture?.close();
  }
}
main().catch(() => {
  console.error(
    "Runtime could not start. Supply --goal and --url (or --synthetic), valid trusted options, OPENROUTER_API_KEY and OPENROUTER_MODEL. Details and secrets are not logged.",
  );
  process.exitCode = 1;
});
