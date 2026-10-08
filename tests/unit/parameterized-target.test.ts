import { expect, it } from "vitest";
import { resolveTarget } from "../../src/replay/targets.js";
import { buildArtifact } from "../../src/runtime/artifact-builder.js";
import { recordDurableTarget } from "../../src/runtime/target-recorder.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import type { Capture } from "../../src/contracts/observation.js";
import {
  resolveDiscoveryArguments,
  assertBoundArguments,
} from "../../src/runtime/discovery-bindings.js";

const capture = (names: string[]): Capture => ({
  observation: {
    status: "ok",
    observation_id: "fresh",
    captured_at: new Date().toISOString(),
    surface: { id: "browser", kind: "browser", title: "Customers" },
    screenshot: { status: "not_requested" },
    controls: {
      status: "available",
      items: names.flatMap((name, i) => [
        {
          ref: `row${i}`,
          role: "row",
          name: `${name} C${i}`,
          text: `${name} C${i}`,
          state: {},
          ancestry: [{ role: "document", name: "", exact: true }],
        },
        {
          ref: `cell${i}`,
          parent_ref: `row${i}`,
          role: "cell",
          name,
          text: name,
          state: {},
          ancestry: [{ role: "document", name: "", exact: true }],
        },
        {
          ref: `id${i}`,
          parent_ref: `row${i}`,
          role: "cell",
          name: `C${i}`,
          text: `C${i}`,
          state: {},
          ancestry: [{ role: "document", name: "", exact: true }],
        },
        {
          ref: `open${i}`,
          parent_ref: `row${i}`,
          role: "link",
          name: `Open ${name} C${i}`,
          text: "Open",
          state: {},
          ancestry: [{ role: "document", name: "", exact: true }],
        },
      ]),
    },
  },
});

it("rejects misplaced row operators and resolves named bound suffix criteria", () => {
  const inputs = { suffix: "7106" },
    declared = { suffix: { type: "string" } };
  expect(() =>
    resolveDiscoveryArguments(
      "click",
      {
        row_match: {
          operator: "ends_with",
          value: { kind: "input", path: "suffix" },
        },
      },
      inputs,
      declared,
    ),
  ).toThrow("Do not put operator/value at the top level");
  expect(
    resolveDiscoveryArguments(
      "click",
      {
        row_match: {
          suffix: {
            operator: "ends_with",
            value: { kind: "input", path: "suffix" },
          },
        },
      },
      inputs,
      declared,
    ).rowMatch,
  ).toEqual({ suffix: { operator: "ends_with", value: "7106" } });
});

it("records a row action without retaining the discovered identity and selects a fresh matching row", () => {
  const original = capture(["Freya", "Mira"]);
  const saved = recordDurableTarget(
    { kind: "control", control_ref: "open0" },
    original,
    undefined,
    { customer: "Freya" },
  ).target;
  expect(JSON.stringify(saved)).not.toContain("Freya");
  expect(JSON.stringify(saved)).not.toContain("C0");
  const fresh = capture(["Mira", "Freya"]);
  const result = resolveTarget(
    saved,
    fresh,
    new Map(),
    {
      inputs: { customer: "Mira" },
      results: {},
      environment: { base_url: "https://example.org" },
    },
    { customer: { kind: "input", path: "customer" } },
  );
  expect(result.target).toEqual({ kind: "control", control_ref: "open0" });
  expect(
    resolveTarget(
      saved,
      capture(["Mira", "Mira"]),
      new Map(),
      {
        inputs: { customer: "Mira" },
        results: {},
        environment: { base_url: "https://example.org" },
      },
      { customer: { kind: "input", path: "customer" } },
    ).diagnosis.reason,
  ).toBe("TARGET_AMBIGUOUS");
  const oneAction = capture(["Mira", "Mira"]);
  if (
    oneAction.observation.status !== "ok" ||
    oneAction.observation.controls.status !== "available"
  )
    throw Error();
  oneAction.observation.controls.items.find((c) => c.ref === "open1")!.text =
    "Inspect";
  expect(
    resolveTarget(
      saved,
      oneAction,
      new Map(),
      {
        inputs: { customer: "Mira" },
        results: {},
        environment: { base_url: "https://example.org" },
      },
      { customer: { kind: "input", path: "customer" } },
    ).diagnosis.reason,
  ).toBe("TARGET_AMBIGUOUS");
  expect(() =>
    recordDurableTarget(
      { kind: "control", control_ref: "open0" },
      capture(["Freya", "Freya"]),
      undefined,
      { customer: "Freya" },
    ),
  ).toThrow("ROW_SELECTION_AMBIGUOUS");
  expect(
    resolveTarget(
      saved,
      capture(["Mira Ann"]),
      new Map(),
      {
        inputs: { customer: "Mira" },
        results: {},
        environment: { base_url: "https://example.org" },
      },
      { customer: { kind: "input", path: "customer" } },
    ).diagnosis.reason,
  ).toBe("TARGET_NOT_FOUND");
});

it("resolves a row-scoped textbox using its stable label", () => {
  const original = capture(["Notebook"]);
  if (
    original.observation.status !== "ok" ||
    original.observation.controls.status !== "available"
  )
    throw Error();
  original.observation.controls.items.push({
    ref: "quantity",
    parent_ref: "row0",
    role: "textbox",
    name: "Quantity",
    state: {},
    ancestry: [{ role: "document", name: "", exact: true }],
  });
  const saved = recordDurableTarget(
    { kind: "control", control_ref: "quantity" },
    original,
    undefined,
    { product_name: "Notebook" },
  ).target;
  const fresh = capture(["Pencil"]);
  if (
    fresh.observation.status !== "ok" ||
    fresh.observation.controls.status !== "available"
  )
    throw Error();
  fresh.observation.controls.items.push({
    ref: "newQuantity",
    parent_ref: "row0",
    role: "textbox",
    name: "Quantity",
    state: {},
    ancestry: [{ role: "document", name: "", exact: true }],
  });
  expect(
    resolveTarget(
      saved,
      fresh,
      new Map(),
      {
        inputs: { product_name: "Pencil" },
        results: {},
        environment: { base_url: "https://example.org" },
      },
      { product_name: { kind: "input", path: "product_name" } },
    ).target,
  ).toEqual({ kind: "control", control_ref: "newQuantity" });
});

it("uses a second criterion to distinguish rows with the same customer name", () => {
  const original = capture(["Freya", "Freya"]);
  const saved = recordDurableTarget(
    { kind: "control", control_ref: "open1" },
    original,
    undefined,
    { customer: "Freya", customer_id: "C1" },
  ).target;
  const result = resolveTarget(
    saved,
    capture(["Freya", "Freya"]),
    new Map(),
    {
      inputs: { customer: "Freya", customer_id: "C1" },
      results: {},
      environment: { base_url: "https://example.org" },
    },
    {
      customer: { kind: "input", path: "customer" },
      customer_id: { kind: "input", path: "customer_id" },
    },
  );
  expect(result.target).toEqual({ kind: "control", control_ref: "open1" });
});

it("preserves input and template arguments while leaving plain mode literal", () => {
  const c: DiscoveryContext = {
    deployment: {
      app_deployment_id: "d",
      base_url: "https://example.org",
      product_id: "p",
      ui_variant: "v",
      vendor_release: null,
      config_version: 1,
    },
    capability_catalog: [],
    inputs: { customer: "Freya", quantity: "3" },
    references: [],
    records: [
      {
        call_id: "n",
        tool: "navigate",
        input: { url: "https://example.org" },
        result: { status: "completed" },
      },
      {
        call_id: "t",
        tool: "type_text",
        input: {
          observation_id: "old",
          target: { kind: "control", control_ref: "c1" },
          text: {
            kind: "template",
            parts: ["Order ", { kind: "input", path: "quantity" }],
          },
          mode: "replace",
        },
        target: {
          kind: "semantic",
          role: "textbox",
          name: { kind: "literal", value: "Quantity" },
          exact: true,
          scope: null,
          required_matches: 1,
        },
        result: { status: "completed" },
      },
    ],
  };
  const a = buildArtifact(c, "Order", {}).definition;
  expect(a.steps[1]?.arguments.text).toEqual({
    kind: "template",
    parts: [
      { kind: "literal", value: "Order " },
      { kind: "input", path: "quantity" },
    ],
  });
  expect(a.steps[1]?.arguments.mode).toEqual({
    kind: "literal",
    value: "replace",
  });
});

it("turns a numeric input binding into text for type_text", () => {
  expect(() =>
    assertBoundArguments(
      "type_text",
      { text: { kind: "literal", value: "" } },
      { customer: "Era" },
    ),
  ).not.toThrow();
  expect(() =>
    resolveDiscoveryArguments(
      "type_text",
      { text: '{"path":"customer","kind":"input"}' },
      { customer: "Freya" },
      { customer: { type: "string" } },
    ),
  ).toThrow("JSON object");
  expect(() =>
    resolveDiscoveryArguments(
      "type_text",
      { text: '{kind:\\"input\\",path:\\"customer\\"}' },
      { customer: "Freya" },
      { customer: { type: "string" } },
    ),
  ).toThrow("JSON object");
  expect(
    resolveDiscoveryArguments(
      "type_text",
      { text: { kind: "literal", value: "" } },
      {},
      {},
    ).resolved.text,
  ).toBe("");
  expect(
    resolveDiscoveryArguments(
      "type_text",
      { text: { kind: "input", path: "quantity" } },
      { quantity: 3 },
      { quantity: { type: "number" } },
    ).resolved.text,
  ).toBe("3");
});

it("preserves an input binding nested in select_option arguments", () => {
  const c: DiscoveryContext = {
    deployment: {
      app_deployment_id: "d",
      base_url: "https://example.org",
      product_id: "p",
      ui_variant: "v",
      vendor_release: null,
      config_version: 1,
    },
    capability_catalog: [],
    inputs: { month: "January" },
    references: [],
    metadata: {
      name: "Select month",
      description: "Select a reporting month",
      input_schema: {
        type: "object",
        properties: { month: { type: "string" } },
        required: ["month"],
        additionalProperties: false,
      },
      example_inputs: { month: "January" },
    },
    records: [
      {
        call_id: "n",
        tool: "navigate",
        input: { url: "https://example.org" },
        result: { status: "completed" },
      },
      {
        call_id: "s",
        tool: "select_option",
        input: {
          observation_id: "old",
          target: { kind: "control", control_ref: "c1" },
          option: { label: { kind: "input", path: "month" } },
        },
        target: {
          kind: "semantic",
          role: "combobox",
          name: { kind: "literal", value: "Month" },
          exact: true,
          scope: null,
          required_matches: 1,
        },
        result: { status: "completed" },
      },
    ],
  };
  expect(
    buildArtifact(c, "Select month", {}).definition.steps[1]?.arguments.option,
  ).toEqual({ label: { kind: "input", path: "month" } });
  c.records[1]!.input.option.label = "January";
  expect(() => buildArtifact(c, "Select month", {})).toThrow(
    "UNBOUND_INPUT_ARGUMENT",
  );
});

it("uses stable visible action text instead of a dynamic accessible name", () => {
  const original = capture([]);
  if (
    original.observation.status !== "ok" ||
    original.observation.controls.status !== "available"
  )
    throw Error();
  original.observation.controls.items.push({
    ref: "transactions",
    role: "link",
    name: "Transactions for 012-9637106",
    text: "Transactions",
    state: {},
    ancestry: [{ role: "document", name: "", exact: true }],
    frame: { name: "", url_path: "/accounts/012-9637106" },
  });
  const saved = recordDurableTarget(
    { kind: "control", control_ref: "transactions" },
    original,
    undefined,
    undefined,
    { account_number: "012-9637106" },
  ).target;
  expect(JSON.stringify(saved)).not.toContain("012-9637106");
  const fresh = structuredClone(original);
  if (
    fresh.observation.status !== "ok" ||
    fresh.observation.controls.status !== "available"
  )
    throw Error();
  fresh.observation.controls.items[0]!.name = "Transactions for 012-1111111";
  fresh.observation.controls.items[0]!.frame = {
    name: "",
    url_path: "/accounts/012-1111111",
  };
  expect(
    resolveTarget(saved, fresh, new Map(), {
      inputs: {},
      results: {},
      environment: { base_url: "https://example.org" },
    }).target,
  ).toEqual({ kind: "control", control_ref: "transactions" });
});

it("does not retain short variable identifiers in target metadata", () => {
  const original = capture([]);
  if (
    original.observation.status !== "ok" ||
    original.observation.controls.status !== "available"
  )
    throw Error();
  original.observation.controls.items.push({
    ref: "account",
    role: "link",
    name: "Account C1",
    text: "Account",
    state: {},
    ancestry: [{ role: "document", name: "", exact: true }],
    frame: { name: "", url_path: "/customers/C1" },
  });
  const saved = recordDurableTarget(
    { kind: "control", control_ref: "account" },
    original,
    undefined,
    undefined,
    { customer_id: "C1" },
  ).target;
  expect(JSON.stringify(saved)).not.toContain("C1");
});

it("rejects saved literal business outputs for parameterized capabilities", () => {
  const c: DiscoveryContext = {
    deployment: {
      app_deployment_id: "d",
      base_url: "https://example.org",
      product_id: "p",
      ui_variant: "v",
      vendor_release: null,
      config_version: 1,
    },
    capability_catalog: [],
    inputs: { customer: "Freya" },
    references: [],
    metadata: {
      name: "Find customer",
      description: "Find customer status",
      input_schema: {
        type: "object",
        properties: { customer: { type: "string" } },
        required: ["customer"],
        additionalProperties: false,
      },
      example_inputs: { customer: "Freya" },
    },
    records: [
      {
        call_id: "n",
        tool: "navigate",
        input: { url: "https://example.org" },
        result: { status: "completed" },
      },
    ],
  };
  expect(() => buildArtifact(c, "Find Freya", { status: "Active" })).toThrow(
    "UNBOUND_OUTPUT",
  );
  c.records.push({
    call_id: "t",
    tool: "type_text",
    input: {
      observation_id: "old",
      target: { kind: "control", control_ref: "c1" },
      text: "Freya",
      mode: "replace",
    },
    target: {
      kind: "semantic",
      role: "textbox",
      name: { kind: "literal", value: "Search" },
      exact: true,
      scope: null,
      required_matches: 1,
    },
    result: { status: "completed" },
  });
  expect(() => buildArtifact(c, "Find Freya", {})).toThrow(
    "UNBOUND_INPUT_ARGUMENT",
  );
});
