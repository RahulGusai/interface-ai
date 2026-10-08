import { it, expect } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { startFixture } from "../helpers/fixture-server.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import { projectMessages } from "../../src/runtime/history.js";
import type { AuditRecord } from "../../src/runtime/audit.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";

const html = `<!doctype html><title>Account</title>
<div id="overview">
  <h1>Account overview</h1>
  <p aria-label="Account number">012-9637106</p>
  <p aria-label="Current balance">8610.41</p>
  <button onclick="document.getElementById('overview').remove(); document.getElementById('transactions').hidden=false">Transactions</button>
</div>
<div id="transactions" hidden>
  <h1>January 2026 transactions</h1>
  <p aria-label="Transaction totals">1297.04</p>
  <p aria-label="Largest debit">571.30</p>
  <p aria-label="Debit date">2026-01-13</p>
  <p aria-label="Debit description">ATM WITHDRAWAL - BR 031</p>
</div>`;
const semantic = (role: string, name: string) => ({
  kind: "semantic",
  role,
  name: { kind: "literal", value: name },
  exact: true,
  scope: null,
  required_matches: 1,
});
const field = (name: string, label: string, output_type = "string") => ({
  name,
  target: semantic("text", label),
  property: "text",
  output_type,
});

it("builds extraction output bindings from the recorded overview and transaction steps", async () => {
  const fixture = await startFixture(undefined, html);
  const records: AuditRecord[] = [];
  const providerHistories: any[][] = [];
  const overviewFields = [
    field("account_number", "Account number"),
    field("current_balance", "Current balance", "number"),
  ];
  const transactionFields = [
    field("transaction_totals", "Transaction totals", "number"),
    field("largest_debit", "Largest debit", "number"),
    field("debit_date", "Debit date"),
    field("debit_description", "Debit description"),
  ];
  const outputs = {
    account_number: "012-9637106",
    current_balance: 8610.41,
    largest_debit: 571.3,
    debit_date: "2026-01-13",
    debit_description: "ATM WITHDRAWAL - BR 031",
  };
  const discovery: DiscoveryContext = {
    deployment: {
      app_deployment_id: "test",
      base_url: fixture.url,
      product_id: "bank",
      ui_variant: "standard",
      vendor_release: null,
      config_version: 1,
    },
    capability_catalog: [],
    inputs: {},
    metadata: {
      name: "Read account",
      description: "Read account details",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      example_inputs: {},
    },
    records: [],
    references: [],
  };
  let turn = 0;
  try {
    const result = await runTask(
      {
        goal: "Read account number, current balance and largest January debit",
        targetUrl: fixture.url,
      },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
        model: {
          model: "scripted-test",
          async complete(messages) {
            providerHistories.push(projectMessages(messages));
            const o = lastObservation(messages);
            const target = (role: string, name: string) => ({
              kind: "control",
              control_ref:
                o.controls.status === "available"
                  ? o.controls.items.find(
                      (c) => c.role === role && c.name === name,
                    )?.ref
                  : undefined,
            });
            let name: string, input: any;
            switch (++turn) {
              case 1:
              case 3: {
                name = "extract_data";
                const fields = turn === 1 ? overviewFields : transactionFields;
                input = {
                  observation_id: o.observation_id,
                  fields: fields.map((f) => ({
                    ...f,
                    target: target(f.target.role, f.target.name.value),
                  })),
                };
                break;
              }
              case 2:
                name = "click";
                input = {
                  observation_id: o.observation_id,
                  target: target("button", "Transactions"),
                };
                break;
              default:
                name = "finish_task";
                input = {
                  outcome: "goal_achieved",
                  summary: "Account read",
                  outputs,
                };
                break;
            }
            const calls = [
              { id: `c${turn}`, name, argumentsJson: JSON.stringify(input) },
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
      {
        discovery,
        maxToolCalls: 6,
        onAudit: async (record) => {
          records.push(record);
        },
      },
    );
    expect(result.status).toBe("goal_achieved");
    expect(result.outputs).toEqual(outputs);
    expect(turn).toBe(4);
    expect(
      records.find((r) => r.type === "tool_finished" && r.call.id === "c4"),
    ).toMatchObject({ result: { status: "accepted" } });
    const historicalOverview = providerHistories[3]!.find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    );
    const preserved = JSON.parse(historicalOverview.content);
    expect(preserved).toMatchObject({
      fields: {
        current_balance: { status: "extracted", value: 8610.41 },
        account_number: { status: "extracted", value: "012-9637106" },
      },
    });
    expect(preserved).not.toHaveProperty("observation");
    expect(
      discovery.artifact?.definition.output_mapping.current_balance,
    ).toEqual({
      kind: "step_output",
      step_id: "step_2",
      path: "fields.current_balance.value",
    });
    expect(discovery.artifact?.observed_outputs).toEqual(outputs);
    expect(records.filter((r) => r.type === "tool_started")).toHaveLength(5);
    expect(records.filter((r) => r.type === "tool_finished")).toHaveLength(5);
  } finally {
    await fixture.close();
  }
});
