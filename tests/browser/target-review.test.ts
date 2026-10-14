import { expect, it } from "vitest";
import { startFixture } from "../helpers/fixture-server.js";
import { createBrowserFactory } from "../helpers/fixture-browser-factory.js";
import { readFile } from "node:fs/promises";
import { runReplay } from "../../src/replay/run-replay.js";
const original = JSON.parse(
  await readFile(
    new URL("../fixtures/replay-member-desk/artifact.json", import.meta.url),
    "utf8",
  ),
);
it("returns child-frame bounds in global screenshot coordinates", async () => {
  const fixture = await startFixture(
    undefined,
    `<iframe style="position:absolute;left:200px;top:150px;width:300px;height:200px" srcdoc='<button style="position:absolute;left:40px;top:30px;width:80px;height:30px">Save</button>'></iframe>`,
  );
  const adapter = await createBrowserFactory({ headless: true }).createForTask({
    goal: "bounds",
    targetUrl: fixture.url,
  });
  try {
    await adapter.execute({ name: "navigate", input: { url: fixture.url } });
    const capture = await adapter.capture("both");
    const o: any = capture.observation;
    const control = o.controls.items.find(
      (c: any) => c.role === "button" && c.name === "Save",
    );
    const bounds = await adapter.targetBounds!({
      kind: "control",
      control_ref: control.ref,
    });
    expect(bounds!.x).toBeGreaterThanOrEqual(240);
    expect(bounds!.y).toBeGreaterThanOrEqual(180);
    expect(bounds!.width).toBe(80);
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
it("resolves multiple extraction fields together after each reviewed capture", async () => {
  const fixture = await startFixture(
    undefined,
    '<p aria-label="Account">first</p><p aria-label="Account">second</p><p aria-label="Balance">10</p><p aria-label="Balance">20</p>',
  );
  const definition = structuredClone(original);
  definition.entry.checks = [];
  definition.steps = [definition.steps[3]];
  definition.steps[0].arguments.fields = ["Account", "Balance"].map((name) => ({
    name: name.toLowerCase(),
    target: {
      kind: "semantic",
      role: "text",
      name: { kind: "literal", value: name },
      exact: true,
      scope: null,
      required_matches: 1,
    },
    property: "text",
    output_type: "string",
  }));
  definition.success_checks = [
    {
      check_id: "done",
      kind: "tool_status_equals",
      step_id: "s004",
      expected: "completed",
    },
  ];
  definition.business_outcomes = [];
  definition.input_schema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  definition.output_schema = {
    type: "object",
    properties: { account: { type: "string" }, balance: { type: "string" } },
    required: ["account", "balance"],
    additionalProperties: false,
  };
  definition.output_mapping = Object.fromEntries(
    ["account", "balance"].map((name) => [
      name,
      { kind: "step_output", step_id: "s004", path: `fields.${name}.value` },
    ]),
  );
  let reviews = 0;
  let finished = 0;
  try {
    const result = await runReplay(
      {
        artifact: { definition },
        inputs: {},
        deployment: {
          app_deployment_id: "test",
          base_url: fixture.url,
          config_version: 1,
          product_id: "desk",
          ui_variant: "standard",
          vendor_release: null,
        },
        assets: [],
        staging_directory: "/tmp",
      },
      { adapterFactory: createBrowserFactory({ headless: true }) },
      {
        onAudit: async (type, payload) => {
          if (type === "tool_finished" && payload.tool === "extract_data")
            finished++;
        },
        review: async (request) => {
          reviews++;
          return {
            review_id: `r${reviews}`,
            status: "approved",
            selected_candidate_id: request.target_resolution!.candidates[1]!.id,
          };
        },
      },
    );
    expect(result).toMatchObject({
      status: "success",
      outputs: { account: "second", balance: "20" },
    });
    expect(reviews).toBe(2);
    expect(finished).toBe(1);
  } finally {
    await fixture.close();
  }
});
it("bounds hung target reads and treats detached child-frame bindings as stale", async () => {
  const fixture = await startFixture(
    undefined,
    `<iframe srcdoc='<button>Save</button>'></iframe>`,
  );
  const adapter: any = await createBrowserFactory({
    headless: true,
    captureMs: 100,
  }).createForTask({ goal: "bounds", targetUrl: fixture.url });
  try {
    await adapter.execute({ name: "navigate", input: { url: fixture.url } });
    const capture = await adapter.capture("both");
    const control = capture.observation.controls.items.find(
      (c: any) => c.name === "Save",
    );
    const element = adapter.bindings.get(control.ref).element;
    const evaluate = element.evaluate;
    element.evaluate = () => new Promise(() => {});
    const start = performance.now();
    await expect(
      adapter.targetBounds({ kind: "control", control_ref: control.ref }),
    ).rejects.toMatchObject({ code: "REVIEW_TARGET_STALE" });
    expect(performance.now() - start).toBeLessThan(1000);
    element.evaluate = evaluate;
    await adapter.page.evaluate(() => {
      document.querySelector("iframe")!.style.position = "absolute";
      document.querySelector("iframe")!.style.left = "30px";
    });
    await expect(
      adapter.targetBounds({ kind: "control", control_ref: control.ref }),
    ).rejects.toMatchObject({ code: "REVIEW_TARGET_STALE" });
    const refreshed = await adapter.capture("both");
    const currentControl = refreshed.observation.controls.items.find(
      (c: any) => c.name === "Save",
    );
    await adapter.page.evaluate(() =>
      document.querySelector("iframe")!.remove(),
    );
    await expect(
      adapter.targetBounds({
        kind: "control",
        control_ref: currentControl.ref,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_TARGET_STALE" });
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
