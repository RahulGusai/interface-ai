import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { syntheticPolicy } from "../../src/runtime/policy.js";
import { startFixture } from "../helpers/fixture-server.js";
import type { Observation } from "../../src/contracts/observation.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
const obs = (r: ToolResponse) => {
  const o = "observation" in r.result ? r.result.observation : r.result;
  if (o.status !== "ok") throw new Error(JSON.stringify(o));
  return o;
};
const target = (o: Extract<Observation, { status: "ok" }>, name: string) => {
  if (o.controls.status !== "available") throw new Error("No controls");
  const c =
    o.controls.items.find((c) => c.name === name && c.role !== "text") ??
    o.controls.items.find((c) => c.name === name);
  if (!c) throw new Error("Missing " + name);
  return { kind: "control" as const, control_ref: c.ref };
};
it("isolates task references, validates iframe fields, checks once and waits without model calls", async () => {
  const fixture = await startFixture();
  const policy = syntheticPolicy(fixture.url);
  const a = await BrowserAdapter.create(policy, {
    headless: true,
    waitMs: 600,
    pollMs: 20,
  });
  const b = await BrowserAdapter.create(policy, { headless: true });
  try {
    let o = obs(
      await a.execute({ name: "navigate", input: { url: fixture.url } }),
    );
    await b.execute({ name: "navigate", input: { url: fixture.url } });
    expect(
      (
        await b.execute({
          name: "click",
          input: {
            observation_id: o.observation_id,
            target: target(o, "Search"),
          },
        })
      ).result,
    ).toMatchObject({ code: "STALE_OBSERVATION" });
    let r = await a.execute({
      name: "type_text",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Frame field"),
        text: "iframe",
        mode: "replace",
      },
    });
    expect(r.result).toMatchObject({ verification: "matched" });
    o = obs(r);
    r = await a.execute({
      name: "check_ui",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Delayed"),
        condition: { kind: "enabled" },
      },
    });
    expect(r.result).toMatchObject({ verdict: "fail" });
    o = obs(r);
    r = await a.execute({
      name: "click",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Enable later"),
      },
    });
    o = obs(r);
    r = await a.execute({
      name: "wait_for",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Delayed"),
        condition: { kind: "enabled" },
      },
    });
    expect(r.result).toMatchObject({ status: "condition_met" });
    o = obs(r);
    r = await a.execute({
      name: "wait_for",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Delayed"),
        condition: { kind: "text_equals", expected: "never" },
      },
    });
    expect(r.result).toMatchObject({ status: "timed_out" });
  } finally {
    await a.close();
    await b.close();
    await fixture.close();
  }
});
it("blocks redirect and link destinations before contacting forbidden server", async () => {
  const fixture = await startFixture();
  for (const name of ["Redirect link", "Forbidden link"]) {
    const a = await BrowserAdapter.create(syntheticPolicy(fixture.url), {
      headless: true,
    });
    try {
      const o = obs(
        await a.execute({ name: "navigate", input: { url: fixture.url } }),
      );
      const r = await a.execute({
        name: "click",
        input: { observation_id: o.observation_id, target: target(o, name) },
      });
      expect(r.result).toMatchObject({
        status: "blocked",
        blocker: { kind: "policy" },
      });
      expect(
        (await a.execute({ name: "observe_ui", input: { mode: "both" } }))
          .result.status,
      ).toBe("needs_intervention");
    } finally {
      await a.close();
    }
  }
  await fixture.close();
});
it("rejects disabled text and options without blind input, scroll boundary preserves parent and focus", async () => {
  const fixture = await startFixture();
  const a = await BrowserAdapter.create(syntheticPolicy(fixture.url), {
    headless: true,
  });
  try {
    let o = obs(
      await a.execute({ name: "navigate", input: { url: fixture.url } }),
    );
    let r = await a.execute({
      name: "select_option",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Plan"),
        option: { label: "Unavailable" },
      },
    });
    expect(r.result.status).toBe("blocked");
    o = obs(r);
    r = await a.execute({
      name: "type_text",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Delayed"),
        mode: "replace",
        text: "x",
      },
    });
    expect(r.result.status).toBe("blocked");
    o = obs(r);
    for (let i = 0; i < 5; i++) {
      r = await a.execute({
        name: "scroll",
        input: {
          observation_id: o.observation_id,
          target: target(o, "Scrollable panel"),
          direction: "down",
          distance: 2,
        },
      });
      o = obs(r);
    }
    expect(r.result).toMatchObject({
      status: "completed",
      movement: "no_movement",
    });
  } finally {
    await a.close();
    await fixture.close();
  }
});
