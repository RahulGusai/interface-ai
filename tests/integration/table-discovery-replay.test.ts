import { expect, it } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { runReplay } from "../../src/replay/run-replay.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { startFixture } from "../helpers/fixture-server.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";

it("records table columns and bound suffix criteria, then extracts a different account on replay", async () => {
  const fixture = await startFixture(
    undefined,
    `<table aria-label="Accounts"><thead><tr><th>Account number</th><th>Current balance</th></tr></thead><tbody><tr style="display:none"><td>hidden</td><td>$999.00</td></tr><tr><td>012-9637106</td><td>$100.00</td></tr><tr><td>012-1230042</td><td>$200.00</td></tr></tbody></table>`,
  );
  try {
    const context: DiscoveryContext = {
      deployment: {
        app_deployment_id: "d",
        base_url: fixture.url,
        product_id: "p",
        ui_variant: "v",
        vendor_release: null,
        config_version: 1,
      },
      inputs: {},
      capability_catalog: [],
      records: [],
      references: [],
    };
    let turn = 0;
    const result = await runTask(
      { goal: "Read account ending 7106", targetUrl: fixture.url },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
        model: {
          model: "fake",
          generateCapability: async () => ({
            name: "Read account",
            description: "Read the matching account",
            input_schema: {
              type: "object",
              properties: { suffix: { type: "string" } },
              required: ["suffix"],
              additionalProperties: false,
            },
            example_inputs: { suffix: "7106" },
          }),
          complete: async (messages) => {
            const observation = lastObservation(messages);
            if (observation.controls.status !== "available")
              throw Error("Missing controls");
            const values = observation.controls.items;
            expect(
              values.find((c) => c.role === "cell" && c.text === "012-9637106")
                ?.table_cell?.row_index,
            ).toBe(0);
            const args =
              turn++ === 0
                ? {
                    observation_id: observation.observation_id,
                    fields: [
                      {
                        name: "account_number",
                        target: {
                          kind: "control",
                          control_ref: values.find(
                            (c) =>
                              c.role === "cell" && c.text === "012-9637106",
                          )!.ref,
                        },
                        property: "text",
                        output_type: "string",
                        row_match: {
                          suffix: {
                            operator: "ends_with",
                            value: { kind: "input", path: "suffix" },
                          },
                        },
                      },
                      {
                        name: "balance",
                        target: {
                          kind: "control",
                          control_ref: values.find(
                            (c) => c.role === "cell" && c.text === "$100.00",
                          )!.ref,
                        },
                        property: "text",
                        output_type: "string",
                        row_match: {
                          suffix: {
                            operator: "ends_with",
                            value: { kind: "input", path: "suffix" },
                          },
                        },
                      },
                    ],
                  }
                : {
                    outcome: "goal_achieved",
                    summary: "Read account",
                    outputs: {
                      account_number: "012-9637106",
                      balance: "$100.00",
                    },
                  };
            const calls = [
              {
                id: String(turn),
                name: turn === 1 ? "extract_data" : "finish_task",
                argumentsJson: JSON.stringify(args),
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
      { discovery: context, maxToolCalls: 3 },
    );
    expect(result.status).toBe("goal_achieved");
    const artifact = context.artifact!.definition;
    expect(artifact.steps[1]!.arguments.fields[0].target.kind).toBe(
      "table_cell",
    );
    expect(JSON.stringify(artifact.steps)).not.toContain("9637106");
    const replay = await runReplay(
      {
        artifact: { definition: artifact } as any,
        inputs: { suffix: "0042" },
        deployment: context.deployment,
        assets: [],
        staging_directory: "/tmp",
      },
      { adapterFactory: createBrowserFactory({ headless: true }) },
      { onAudit: async () => {} },
    );
    expect(replay.status).toBe("success");
    expect(replay.outputs).toEqual({
      account_number: "012-1230042",
      balance: "$200.00",
    });
  } finally {
    await fixture.close();
  }
});
