import { expect, it } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { runReplay } from "../../src/replay/run-replay.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { startFixture } from "../helpers/fixture-server.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";

const html = `<!doctype html><title>Customers</title>
<label>Customer search <input id="search"></label>
<table><tbody>
<tr><td>Freya</td><td>C001</td><td><a aria-label="Open Freya C001" href="#freya" onclick="show('Active');return false">Open</a></td></tr>
<tr><td>Mira</td><td>C002</td><td><a aria-label="Open Mira C002" href="#mira" onclick="show('Pending');return false">Open</a></td></tr>
</tbody></table><p aria-label="Status" id="status">No customer</p>
<script>function show(value){document.getElementById('status').textContent=value}</script>`;

it("discovers input binding and row selection, then replays against a different customer and extracts fresh output", async () => {
  const fixture = await startFixture(undefined, html);
  try {
    const discovery: DiscoveryContext = {
      deployment: {
        app_deployment_id: "d",
        base_url: fixture.url,
        product_id: "desk",
        ui_variant: "standard",
        vendor_release: null,
        config_version: 1,
      },
      capability_catalog: [],
      inputs: { customer: "Freya" },
      records: [],
      references: [],
    };
    let turn = 0;
    const result = await runTask(
      { goal: "Find Freya and report status", targetUrl: fixture.url },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
        model: {
          model: "scripted",
          async generateCapability() {
            return {
              name: "Find customer status",
              description: "Find a customer and report status",
              input_schema: {
                type: "object" as const,
                properties: { customer: { type: "string" as const } },
                required: ["customer"],
                additionalProperties: false as const,
              },
              example_inputs: { customer: "Freya" },
            };
          },
          async complete(messages) {
            const o = lastObservation(messages);
            if (o.controls.status !== "available")
              throw Error("controls unavailable");
            const controls = o.controls.items;
            const ref = (role: string, name: string) =>
              controls.find((c) => c.role === role && c.name === name)?.ref;
            let name: string;
            let args: any;
            switch (turn++) {
              case 0:
                name = "type_text";
                args = {
                  observation_id: o.observation_id,
                  target: {
                    kind: "control",
                    control_ref: ref("textbox", "Customer search"),
                  },
                  text: { kind: "input", path: "customer" },
                  mode: "replace",
                };
                break;
              case 1:
                name = "click";
                args = {
                  observation_id: o.observation_id,
                  target: {
                    kind: "control",
                    control_ref: ref("link", "Open Freya C001"),
                  },
                  row_match: { customer: { kind: "input", path: "customer" } },
                };
                break;
              case 2:
                name = "extract_data";
                args = {
                  observation_id: o.observation_id,
                  fields: [
                    {
                      name: "status",
                      target: {
                        kind: "control",
                        control_ref: ref("text", "Status"),
                      },
                      property: "text",
                      output_type: "string",
                    },
                  ],
                };
                break;
              default:
                name = "finish_task";
                args = {
                  outcome: "goal_achieved",
                  summary: "Found customer",
                  outputs: { status: "Active" },
                };
            }
            const calls = [
              { id: String(turn), name, argumentsJson: JSON.stringify(args) },
            ];
            return {
              kind: "tool_calls" as const,
              calls,
              assistantMessage: {
                role: "assistant" as const,
                content: null,
                tool_calls: calls,
              },
            };
          },
        },
      },
      { discovery },
    );
    expect(result.status).toBe("goal_achieved");
    const proposal = discovery.artifact!;
    expect(proposal.capability_selection).toMatchObject({
      name: "Find customer status",
    });
    expect(proposal.definition.steps[1]?.arguments.text).toEqual({
      kind: "input",
      path: "customer",
    });
    expect(JSON.stringify(proposal.definition.steps[2]?.target)).not.toContain(
      "Freya",
    );
    expect(proposal.definition.output_mapping.status.kind).toBe("step_output");
    const replayFor = (customer: string) =>
      runReplay(
        {
          artifact: { definition: proposal.definition } as any,
          inputs: { customer },
          deployment: discovery.deployment,
          assets: [],
          staging_directory: "/tmp",
        },
        { adapterFactory: createBrowserFactory({ headless: true }) },
        { onAudit: async () => {} },
      );
    expect(await replayFor("Freya")).toMatchObject({
      status: "success",
      outputs: { status: "Active" },
    });
    expect(await replayFor("Mira")).toMatchObject({
      status: "success",
      outputs: { status: "Pending" },
    });
  } finally {
    await fixture.close();
  }
});
