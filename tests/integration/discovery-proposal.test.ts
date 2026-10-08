import { runReplay } from "../../src/replay/run-replay.js";
import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { runTask } from "../../src/runtime/run-task.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { startFixture } from "../helpers/fixture-server.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import type { ModelClient } from "../../src/llm/model-client.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
const html = await readFile(
  new URL("../fixtures/replay-member-desk/index.html", import.meta.url),
  "utf8",
);
it("builds an artifact without a model proposal and keeps inline observation bytes", async () => {
  const fixture = await startFixture(undefined, html);
  try {
    let step = 0,
      images = 0;
    const model: ModelClient = {
      model: "scripted-test",
      async complete(messages) {
        images += messages.filter(
          (m) => m.role === "observation" && m.image.bytes.length > 0,
        ).length;
        const o = lastObservation(messages);
        if (o.controls.status !== "available") throw Error();
        const target = (role: string, name: string) => ({
          kind: "control",
          control_ref:
            o.controls.status === "available"
              ? o.controls.items.find(
                  (c) => c.role === role && c.name === name,
                )!.ref
              : "",
        });
        let name: string, input: any;
        switch (step++) {
          case 0:
            name = "type_text";
            input = {
              observation_id: o.observation_id,
              target: target("textbox", "Member email"),
              mode: "replace",
              text: "demo@example.test",
            };
            break;
          case 1:
            name = "click";
            input = {
              observation_id: o.observation_id,
              target: target("button", "Search"),
            };
            break;
          case 2:
            name = "click";
            input = {
              observation_id: o.observation_id,
              target: target("link", "demo@example.test"),
            };
            break;
          case 3:
            name = "extract_data";
            input = {
              observation_id: o.observation_id,
              fields: [
                {
                  name: "status",
                  target: target("text", "Status"),
                  property: "text",
                  output_type: "string",
                },
              ],
            };
            break;
          default:
            name = "finish_task";
            input = {
              observation_id: o.observation_id,
              outcome: "goal_achieved",
              summary: "Status read",
              outputs: { status: "Active" },
            };
        }
        const calls = [
          { id: String(step), name, argumentsJson: JSON.stringify(input) },
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
    };
    const discovery: DiscoveryContext = {
      deployment: {
        app_deployment_id: "test",
        base_url: fixture.url,
        product_id: "desk",
        ui_variant: "standard",
        vendor_release: null,
        config_version: 1,
      },
      capability_catalog: [],
      inputs: { email: "demo@example.test" },
      records: [],
      references: [],
    };
    const result = await runTask(
      {
        goal: "Look up demo@example.test and report status",
        targetUrl: fixture.url,
      },
      {
        model,
        adapterFactory: createBrowserFactory({ headless: true }),
        contract: syntheticContract(),
      },
      { discovery },
    );
    expect(result.status).toBe("goal_achieved");
    expect(discovery.artifact?.parameter_values).toEqual({
      email: "demo@example.test",
    });
    expect(discovery.artifact?.definition.steps.map((s) => s.tool)).toEqual([
      "navigate",
      "type_text",
      "click",
      "click",
      "extract_data",
    ]);
    const replay = await runReplay(
      {
        artifact: { definition: discovery.artifact!.definition } as any,
        inputs: discovery.artifact!.parameter_values,
        deployment: discovery.deployment,
        assets: [],
        staging_directory: "/tmp",
      },
      { adapterFactory: createBrowserFactory({ headless: true }) },
      { onAudit: async () => {} },
    );
    expect(replay).toMatchObject({
      status: "success",
      outputs: { status: "Active" },
    });
    expect(images).toBeGreaterThan(0);
    expect(JSON.stringify(discovery.artifact?.definition)).not.toContain(
      "control_ref",
    );
  } finally {
    await fixture.close();
  }
});
