import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { startFixture } from "../helpers/fixture-server.js";
it("resolves a bound option's case against observed labels but blocks ambiguous labels", async () => {
  const fixture = await startFixture(
    undefined,
    "<label>Direction<select><option>All</option><option>Debit</option><option>Credit</option><option>credit</option></select></label>",
  );
  const adapter = await BrowserAdapter.create({ headless: true });
  try {
    await adapter.execute({ name: "navigate", input: { url: fixture.url } });
    for (const [label, status] of [
      ["debit", "completed"],
      ["CREDIT", "blocked"],
      ["Unknown", "blocked"],
    ]) {
      const capture = await adapter.capture("controls");
      const o = capture.observation as any;
      const control = o.controls.items.find((c: any) => c.role === "combobox");
      const r = await adapter.execute({
        name: "select_option",
        input: {
          observation_id: o.observation_id,
          target: { kind: "control", control_ref: control.ref },
          option: { label: label! },
        },
      });
      expect(r.result.status).toBe(status);
      if (status === "completed")
        expect(r.result).toMatchObject({
          selected_label: "Debit",
          verification: "matched",
        });
    }
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
