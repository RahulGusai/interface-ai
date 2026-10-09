import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { startFixture } from "../helpers/fixture-server.js";
import { isReusableExtractionSource } from "../../src/runtime/extraction-source.js";
import { recordDurableTarget } from "../../src/runtime/target-recorder.js";
import { resolveTarget } from "../../src/replay/targets.js";

it("extracts fresh definition values by their terms across different profiles", async () => {
  const fixture = await startFixture(
    undefined,
    `<input aria-label="Location" oninput="document.querySelector('dd').textContent=this.value === 'Westmere Hall' ? 'C953896' : 'C271413'"><dl><dt>Customer ID</dt><dd>C271413</dd></dl><fieldset><legend>Contact details</legend><dl><dt>Email</dt><dd>freya@example.test</dd></dl></fieldset>`,
  );
  const adapter = await BrowserAdapter.create({ headless: true });
  try {
    await adapter.execute({ name: "navigate", input: { url: fixture.url } });
    const capture = await adapter.capture("controls");
    const o = capture.observation;
    if (o.status !== "ok" || o.controls.status !== "available") throw Error();
    const source = o.controls.items.find((c) => c.text === "C271413")!;
    expect(source).toMatchObject({
      role: "definition",
      name: "Customer ID",
      text: "C271413",
    });
    expect(isReusableExtractionSource(source)).toBe(true);
    const target = recordDurableTarget(
      { kind: "control", control_ref: source.ref },
      capture,
      undefined,
      undefined,
      { location: "Harbor Street" },
    ).target;
    expect(JSON.stringify(target)).not.toContain("C271413");
    const location = o.controls.items.find((c) => c.name === "Location")!;
    await adapter.execute({
      name: "type_text",
      input: {
        observation_id: o.observation_id,
        target: { kind: "control", control_ref: location.ref },
        text: "Westmere Hall",
        mode: "replace",
      },
    });
    const fresh = await adapter.capture("controls");
    const resolved = resolveTarget(target, fresh, new Map(), {
      inputs: { location: "Westmere Hall" },
      results: {},
      environment: { base_url: fixture.url },
    });
    expect(resolved.target).toBeDefined();
    if (
      fresh.observation.status !== "ok" ||
      !resolved.target ||
      resolved.target.kind !== "control"
    )
      throw Error();
    const r = await adapter.execute({
      name: "extract_data",
      input: {
        observation_id: fresh.observation.observation_id,
        fields: [
          {
            name: "customer_id",
            target: resolved.target,
            property: "text",
            output_type: "string",
          },
        ],
      },
    });
    expect(r.result).toMatchObject({
      status: "completed",
      fields: { customer_id: { status: "extracted", value: "C953896" } },
    });
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
