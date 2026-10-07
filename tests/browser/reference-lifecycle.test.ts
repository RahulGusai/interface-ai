import { it, expect } from "vitest";
import { startFixture } from "../helpers/fixture-server.js";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
import type { Observation } from "../../src/contracts/observation.js";
const obs = (r: ToolResponse) => {
  const o = "observation" in r.result ? r.result.observation : r.result;
  if (o.status !== "ok") throw new Error(JSON.stringify(o));
  return o;
};
const target = (o: Extract<Observation, { status: "ok" }>, name: string) => {
  if (o.controls.status !== "available") throw new Error();
  const c =
    o.controls.items.find((c) => c.name === name && c.role === "button") ??
    o.controls.items.find((c) => c.name === name && c.role === "textbox") ??
    o.controls.items.find((c) => c.name === name);
  if (!c) throw new Error("Missing " + name);
  return { kind: "control" as const, control_ref: c.ref };
};
const html = `<html><body><label>Entry<input id=input></label><button id=search onclick="count.textContent=String(Number(count.textContent)+1)">Search</button><p id=count>0</p><button onclick="setTimeout(()=>search.textContent='Delete',400)">Repurpose</button><button onclick="setTimeout(()=>search.remove(),400)">Remove</button><button onclick="setTimeout(()=>location.reload(),400)">Reload</button><button onclick="setTimeout(()=>document.body.style.marginLeft='100px',400)">Move</button><button onclick="document.querySelector('input').setSelectionRange(1,1)">Middle caret</button><button onclick="setTimeout(()=>document.querySelector('iframe').src='/frame?replaced',400)">Replace frame</button><iframe src='/frame'></iframe></body></html>`;
it("exact bindings reject same-node action identity changes; missing targets satisfy hidden but not value checks", async () => {
  const f = await startFixture(undefined, html);
  const a = await BrowserAdapter.create({
    headless: true,
  });
  try {
    let o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    o = obs(
      await a.execute({
        name: "click",
        input: {
          observation_id: o.observation_id,
          target: target(o, "Repurpose"),
        },
      }),
    );
    const search = target(o, "Search");
    await new Promise((r) => setTimeout(r, 500));
    const blocked = await a.execute({
      name: "click",
      input: { observation_id: o.observation_id, target: search },
    });
    expect(blocked.result).toMatchObject({
      status: "blocked",
      code: "TARGET_CHANGED",
    });
    o = obs(blocked);
    o = obs(
      await a.execute({
        name: "click",
        input: {
          observation_id: o.observation_id,
          target: target(o, "Remove"),
        },
      }),
    );
    const removed = target(o, "Delete");
    await new Promise((r) => setTimeout(r, 500));
    const check = await a.execute({
      name: "check_ui",
      input: {
        observation_id: o.observation_id,
        target: removed,
        condition: { kind: "hidden" },
      },
    });
    expect(check.result).toMatchObject({
      status: "evaluated",
      verdict: "pass",
    });
  } finally {
    await a.close();
    await f.close();
  }
});
it("document and iframe replacement invalidate waits; coordinate layout drift is rejected", async () => {
  const f = await startFixture(undefined, html);
  for (const name of ["Reload", "Replace frame", "Move"]) {
    const a = await BrowserAdapter.create({
      headless: true,
      waitMs: 1200,
      pollMs: 20,
    });
    try {
      let o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
      o = obs(
        await a.execute({
          name: "click",
          input: { observation_id: o.observation_id, target: target(o, name) },
        }),
      );
      if (name === "Move") {
        await new Promise((r) => setTimeout(r, 500));
        expect(
          (
            await a.execute({
              name: "click",
              input: {
                observation_id: o.observation_id,
                target: { kind: "point", x: 20, y: 20 },
              },
            })
          ).result,
        ).toMatchObject({ code: "LAYOUT_CHANGED" });
      } else
        expect(
          (
            await a.execute({
              name: "wait_for",
              input: {
                observation_id: o.observation_id,
                target: target(o, "Entry"),
                condition: { kind: "value_equals", expected: "never" },
              },
            })
          ).result.status,
        ).toBe("invalidated");
    } finally {
      await a.close();
    }
  }
  await f.close();
});
it("append uses field end, targeted Enter activates only once, and extraction keys are safe", async () => {
  const f = await startFixture(undefined, html);
  const a = await BrowserAdapter.create({
    headless: true,
  });
  try {
    let o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    o = obs(
      await a.execute({
        name: "type_text",
        input: {
          observation_id: o.observation_id,
          target: target(o, "Entry"),
          text: "abc",
          mode: "replace",
        },
      }),
    );
    o = obs(
      await a.execute({
        name: "click",
        input: {
          observation_id: o.observation_id,
          target: target(o, "Middle caret"),
        },
      }),
    );
    o = obs(
      await a.execute({
        name: "type_text",
        input: {
          observation_id: o.observation_id,
          target: target(o, "Entry"),
          text: "d",
          mode: "append",
        },
      }),
    );
    let check = await a.execute({
      name: "check_ui",
      input: {
        observation_id: o.observation_id,
        target: target(o, "Entry"),
        condition: { kind: "value_equals", expected: "abcd" },
      },
    });
    expect(check.result).toMatchObject({ verdict: "pass" });
    o = obs(check);
    o = obs(
      await a.execute({
        name: "press_key",
        input: {
          observation_id: o.observation_id,
          target: target(o, "Search"),
          keys: ["Enter"],
        },
      }),
    );
    const result = await a.execute({
      name: "extract_data",
      input: {
        observation_id: o.observation_id,
        fields: [
          {
            name: "__proto__",
            target: target(o, "1"),
            property: "text",
            output_type: "number",
          },
        ],
      },
    });
    expect(result.result).toMatchObject({ status: "completed" });
    if ("fields" in result.result)
      expect(
        Object.getOwnPropertyDescriptor(result.result.fields, "__proto__")
          ?.value,
      ).toEqual({ status: "extracted", value: 1 });
  } finally {
    await a.close();
    await f.close();
  }
});
