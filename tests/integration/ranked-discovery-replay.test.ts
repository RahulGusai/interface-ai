import { expect, it } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { runReplay } from "../../src/replay/run-replay.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { startFixture } from "../helpers/fixture-server.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
it("replays an explicit sorted rank against different filtered values", async () => {
  const fixture = await startFixture(
    undefined,
    `<label>Period<input aria-label="Period" oninput="document.querySelector('#large').textContent = this.value === 'February' ? '-$800.00' : '-$571.30'"></label>
  <table aria-label="Transactions"><thead><tr><th>Date</th><th id="amount"><button onclick="document.querySelector('#amount').setAttribute('aria-sort','ascending')">Amount</button></th></tr></thead><tbody><tr><td>13</td><td id="large">-$571.30</td></tr><tr><td>14</td><td>-$10.00</td></tr></tbody></table>`,
  );
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
  try {
    const result = await runTask(
      { goal: "Read largest debit in January", targetUrl: fixture.url },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
        model: {
          model: "fake",
          generateCapability: async () => ({
            name: "largest",
            description: "Read ranked result",
            input_schema: {
              type: "object",
              properties: { period: { type: "string" } },
              required: ["period"],
              additionalProperties: false,
            },
            example_inputs: { period: "January" },
          }),
          complete: async (messages) => {
            const o = lastObservation(messages);
            if (o.controls.status !== "available") throw Error();
            const control = (role: string, name: string) => ({
              kind: "control",
              control_ref:
                o.controls.status === "available"
                  ? o.controls.items.find(
                      (c) => c.role === role && c.name === name,
                    )!.ref
                  : "",
            });
            const name = ["type_text", "click", "extract_data", "finish_task"][
              turn
            ]!;
            const args = [
              {
                observation_id: o.observation_id,
                target: control("textbox", "Period"),
                text: { kind: "input", path: "period" },
                mode: "replace",
              },
              {
                observation_id: o.observation_id,
                target: control("button", "Amount"),
              },
              {
                observation_id: o.observation_id,
                fields: [
                  {
                    name: "largest",
                    target: control("cell", "-$571.30"),
                    property: "text",
                    output_type: "string",
                    row_rank: {
                      column: "Amount",
                      direction: "ascending",
                      row_index: 0,
                    },
                  },
                ],
              },
              {
                outcome: "goal_achieved",
                summary: "Read largest",
                outputs: { largest: "-$571.30" },
              },
            ][turn++];
            const calls = [
              { id: String(turn), name, argumentsJson: JSON.stringify(args) },
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
      { discovery: context, maxToolCalls: 5 },
    );
    expect(result.status).toBe("goal_achieved");
    const artifact = context.artifact!.definition;
    expect(artifact.steps[3]!.arguments.fields[0]).not.toHaveProperty(
      "row_rank",
    );
    expect(artifact.steps[3]!.arguments.fields[0].target).toMatchObject({
      row_index: 0,
      sort: { column_index: 1, direction: "ascending" },
    });
    const replay = await runReplay(
      {
        artifact: { definition: artifact } as any,
        inputs: { period: "February" },
        deployment: context.deployment,
        assets: [],
        staging_directory: "/tmp",
      },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
      },
      { onAudit: async () => {} },
    );
    expect(replay).toMatchObject({
      status: "success",
      outputs: { largest: "-$800.00" },
    });
  } finally {
    await fixture.close();
  }
});
