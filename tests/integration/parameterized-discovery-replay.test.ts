import { expect, it } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { runReplay } from "../../src/replay/run-replay.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { startFixture } from "../helpers/fixture-server.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import { OpenRouterClient } from "../../src/llm/openrouter-client.js";
import type { AuditRecord } from "../../src/runtime/audit.js";

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
            const client = new OpenRouterClient(
              { apiKey: "fake", model: "mock" },
              async () =>
                new Response(
                  JSON.stringify({
                    choices: [
                      {
                        message: {
                          tool_calls: [
                            {
                              id: "metadata",
                              type: "function",
                              function: {
                                name: "define_capability",
                                arguments: JSON.stringify({
                                  name: "Find customer status",
                                  description:
                                    "Find a customer and report status",
                                  inputs: [
                                    {
                                      name: "customer",
                                      description: "Customer name",
                                      example: "Freya",
                                    },
                                  ],
                                }),
                              },
                            },
                          ],
                        },
                      },
                    ],
                  }),
                ),
            );
            return client.generateCapability(
              "Find Freya and report status",
              discovery.inputs,
            );
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

it.each([
  { nameCell: "Freya", code: "ROW_SELECTION_AMBIGUOUS" },
  { nameCell: "Freya SAME NAME", code: "ROW_SELECTION_MISMATCH" },
])(
  "provides clarification guidance for $code without inventing another input",
  async ({ nameCell, code }) => {
    const fixture = await startFixture(
      undefined,
      html
        .replace("<td>Freya</td>", `<td>${nameCell}</td>`)
        .replace("<td>Mira</td>", `<td>${nameCell}</td>`),
    );
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
        metadata: {
          name: "Find customer",
          description: "Find a customer and report their status",
          input_schema: {
            type: "object",
            properties: { customer_name: { type: "string" } },
            required: ["customer_name"],
            additionalProperties: false,
          },
          example_inputs: { customer_name: "Freya" },
        },
        capability_catalog: [],
        inputs: { customer_name: "Freya" },
        records: [],
        references: [],
      };
      const audits: AuditRecord[] = [];
      let turn = 0;
      const result = await runTask(
        { goal: "Find Freya and report status", targetUrl: fixture.url },
        {
          adapterFactory: createBrowserFactory({ headless: true }),
          model: {
            model: "scripted",
            async complete(messages) {
              const o = lastObservation(messages);
              if (o.controls.status !== "available")
                throw Error("controls unavailable");
              const first = turn++ === 0;
              const name = first ? "click" : "request_human";
              const args = first
                ? {
                    observation_id: o.observation_id,
                    target: {
                      kind: "control",
                      control_ref: o.controls.items.find(
                        (c) => c.name === "Open Freya C001",
                      )?.ref,
                    },
                    row_match: {
                      customer_name: { kind: "input", path: "customer_name" },
                    },
                  }
                : {
                    observation_id: o.observation_id,
                    reason: "ambiguous_state",
                    message:
                      "Two customers match Freya. Which customer do you mean?",
                  };
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
        {
          discovery,
          onAudit: (event) => {
            audits.push(event);
          },
        },
      );
      expect(result.status).toBe("needs_intervention");
      expect(turn).toBe(2);
      expect(discovery.artifact).toBeUndefined();
      expect(Object.keys(discovery.metadata!.input_schema.properties)).toEqual([
        "customer_name",
      ]);
      expect(audits).toContainEqual(
        expect.objectContaining({
          type: "discovery_correction",
          code,
          content: expect.stringContaining("request_human"),
        }),
      );
      expect(discovery.records.some((r) => r.tool === "click")).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);
