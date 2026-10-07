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
const binding = (step_id: string, name: string) => ({
  kind: "step_output",
  step_id,
  path: `fields.${name}.value`,
});

it("preserves overview values after navigation and repairs a transaction-total output binding", async () => {
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
  const input_schema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  const output_schema = {
    type: "object",
    properties: {
      account_number: { type: "string" },
      current_balance: { type: "number" },
      largest_debit: { type: "number" },
      debit_date: { type: "string" },
      debit_description: { type: "string" },
    },
    required: Object.keys(outputs),
    additionalProperties: false,
  };
  const definition = {
    surface: "browser",
    compatibility: {
      product_id: "bank",
      ui_variant: "standard",
      vendor_release: null,
    },
    input_schema,
    output_schema,
    entry: { url: { kind: "environment", path: "base_url" }, checks: [] },
    steps: [
      {
        step_id: "read_overview",
        tool: "extract_data",
        arguments: { fields: overviewFields },
      },
      {
        step_id: "open_transactions",
        tool: "click",
        arguments: {},
        target: semantic("button", "Transactions"),
      },
      {
        step_id: "read_transactions",
        tool: "extract_data",
        arguments: { fields: transactionFields },
      },
    ],
    success_checks: [
      {
        check_id: "balance_read",
        kind: "tool_status_equals",
        step_id: "read_overview",
        expected: "completed",
      },
      {
        check_id: "transactions_read",
        kind: "tool_status_equals",
        step_id: "read_transactions",
        expected: "completed",
      },
    ],
    business_outcomes: [],
    output_mapping: {
      account_number: binding("read_overview", "account_number"),
      current_balance: binding("read_transactions", "transaction_totals"),
      largest_debit: binding("read_transactions", "largest_debit"),
      debit_date: binding("read_transactions", "debit_date"),
      debit_description: binding("read_transactions", "debit_description"),
    },
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
              case 5:
                name = "observe_ui";
                input = { mode: "both" };
                break;
              default: {
                name = "finish_task";
                const repaired = structuredClone(definition);
                if (turn >= 6)
                  repaired.output_mapping.current_balance = binding(
                    "read_overview",
                    "current_balance",
                  );
                input = {
                  observation_id: o.observation_id,
                  outcome: "goal_achieved",
                  summary: "Account read",
                  outputs,
                  proposal: {
                    proposal_version: 1,
                    capability_selection: {
                      mode: "new",
                      name: "Account report",
                      description: "Read overview and debit details",
                      reason: "No catalog operation",
                      input_schema,
                      output_schema,
                    },
                    parameter_values: {},
                    observed_outputs: outputs,
                    definition: repaired,
                    reference_assets: [],
                  },
                };
              }
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
    expect(result.status).toBe("awaiting_artifact_design");
    expect(result.outputs).toEqual(outputs);
    expect(turn).toBe(6);
    const rejected = records.find(
      (r) => r.type === "tool_finished" && r.call.id === "c4",
    );
    expect(rejected).toMatchObject({
      result: {
        status: "rejected",
        code: "DURABLE_PROPOSAL_INVALID",
        message: expect.stringContaining("output_mapping/observed_outputs"),
      },
    });
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
      discovery.proposal?.definition.output_mapping.current_balance,
    ).toEqual({
      kind: "step_output",
      step_id: "read_overview",
      path: "fields.current_balance.value",
    });
    expect(discovery.proposal?.observed_outputs).toEqual(outputs);
    expect(records.filter((r) => r.type === "tool_started")).toHaveLength(7);
    expect(records.filter((r) => r.type === "tool_finished")).toHaveLength(7);
  } finally {
    await fixture.close();
  }
});
