import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import { startFixture } from "../helpers/fixture-server.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
import type { Observation } from "../../src/contracts/observation.js";
function observation(r: ToolResponse): Extract<Observation, { status: "ok" }> {
  const o = "observation" in r.result ? r.result.observation : r.result;
  if (o.status !== "ok") throw new Error(JSON.stringify(o));
  return o;
}
const ctrl = (o: Extract<Observation, { status: "ok" }>, name: string) => {
  if (o.controls.status !== "available") throw new Error("No controls");
  const c =
    o.controls.items.find((c) => c.name === name && c.role !== "text") ??
    o.controls.items.find((c) => c.name === name);
  if (!c) throw new Error(`Missing control ${name}`);
  return { kind: "control" as const, control_ref: c.ref };
};
it("real Chromium: semantic entry, single keyboard activation, check/extract, point fallback, selection, stale refs, scroll and dialogs", async () => {
  const fixture = await startFixture();
  const a = await BrowserAdapter.create({ headless: true });
  const context = { adapter: a, busy: false, halted: false };
  let n = 0;
  const send = (name: string, input: unknown) =>
    dispatchTool(context, {
      id: String(++n),
      name,
      argumentsJson: JSON.stringify(input),
    });
  try {
    let o = observation(await send("navigate", { url: fixture.url }));
    expect(o.screenshot.status).toBe("available");
    let r = await send("type_text", {
      observation_id: o.observation_id,
      target: ctrl(o, "Member ID"),
      mode: "replace",
      text: "4",
    });
    expect(r.result).toMatchObject({
      status: "completed",
      verification: "matched",
    });
    o = observation(r);
    r = await send("type_text", {
      observation_id: o.observation_id,
      target: ctrl(o, "Member ID"),
      mode: "append",
      text: "2",
    });
    o = observation(r);
    r = await send("press_key", {
      observation_id: o.observation_id,
      target: ctrl(o, "Search"),
      keys: ["Enter"],
    });
    o = observation(r);
    r = await send("check_ui", {
      observation_id: o.observation_id,
      target: ctrl(o, "Member Ada | 123.50"),
      condition: { kind: "text_equals", expected: "Member Ada | 123.50" },
    });
    expect(r.result).toMatchObject({ status: "evaluated", verdict: "pass" });
    o = observation(r);
    r = await send("extract_data", {
      observation_id: o.observation_id,
      fields: [
        {
          name: "amount",
          target: ctrl(o, "123.50"),
          property: "text",
          output_type: "number",
        },
        {
          name: "bad",
          target: ctrl(o, "$1,234.00"),
          property: "text",
          output_type: "number",
        },
      ],
    });
    expect(r.result).toMatchObject({
      status: "partial",
      fields: {
        amount: { status: "extracted", value: 123.5 },
        bad: { status: "error" },
      },
    });
    o = observation(r);
    const stale = o.observation_id;
    r = await send("select_option", {
      observation_id: o.observation_id,
      target: ctrl(o, "Plan"),
      option: { label: "Premium" },
    });
    expect(r.result).toMatchObject({ verification: "matched" });
    o = observation(r);
    expect(
      (
        await send("click", {
          observation_id: stale,
          target: { kind: "point", x: 700, y: 70 },
        })
      ).result,
    ).toMatchObject({ code: "STALE_OBSERVATION" });
    r = await send("click", {
      observation_id: o.observation_id,
      target: { kind: "point", x: 700, y: 70 },
    });
    expect(r.result.status).toBe("completed");
    o = observation(r);
    r = await send("scroll", {
      observation_id: o.observation_id,
      target: ctrl(o, "Scrollable panel"),
      direction: "down",
      distance: 1,
    });
    expect(r.result).toMatchObject({ status: "completed", movement: "moved" });
    o = observation(r);
    r = await send("click", {
      observation_id: o.observation_id,
      target: ctrl(o, "Known dialog"),
    });
    expect(r.result).toMatchObject({
      status: "completed",
      dialog_events: [{ decision: "accept", action: "accepted" }],
    });
    o = observation(r);
    r = await send("click", {
      observation_id: o.observation_id,
      target: ctrl(o, "Unknown dialog"),
    });
    expect(r.result).toMatchObject({
      status: "completed",
      dialog_events: [{ decision: "accept", action: "accepted" }],
    });
    expect(context.halted).toBe(false);
    expect((await send("observe_ui", { mode: "both" })).result.status).toBe(
      "ok",
    );
  } finally {
    await a.close();
    await fixture.close();
  }
});
it("supports screenshot-only scale-2 points without suppressing images", async () => {
  const fixture = await startFixture();
  const b = await BrowserAdapter.create({
    headless: true,
    deviceScaleFactor: 2,
    semanticCapture: false,
  });
  try {
    let o = observation(
      await b.execute({ name: "navigate", input: { url: fixture.url } }),
    );
    expect(o.screenshot).toMatchObject({ width: 1280, height: 800 });
    expect(
      (
        await b.execute({
          name: "click",
          input: {
            observation_id: o.observation_id,
            target: { kind: "point", x: 700, y: 70 },
          },
        })
      ).result.status,
    ).toBe("completed");
  } finally {
    await b.close();
    await fixture.close();
  }
});
