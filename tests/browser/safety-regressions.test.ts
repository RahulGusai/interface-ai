import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { startFixture } from "../helpers/fixture-server.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
const obs = (r: ToolResponse) => {
  const o = "observation" in r.result ? r.result.observation : r.result;
  if (o.status !== "ok") throw new Error(JSON.stringify(o));
  return o;
};
it("captures a settling search view without dispatching the click again", async () => {
  const f = await startFixture(
    undefined,
    `<button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);const start=performance.now();const timer=setInterval(()=>{document.querySelector('#progress').style.width=(10+(performance.now()-start))+'px';if(performance.now()-start>750){clearInterval(timer);document.querySelector('#progress').textContent='Results ready'}},10)">Search</button><div id="progress" style="width:10px;height:20px">Loading</div>`,
  );
  const a = await BrowserAdapter.create({ headless: true });
  try {
    const o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    const search =
      o.controls.status === "available"
        ? o.controls.items.find((c) => c.name === "Search")!
        : undefined;
    const response = await a.execute({
      name: "click",
      input: {
        observation_id: o.observation_id,
        target: { kind: "control", control_ref: search!.ref },
      },
    });
    expect(response.result).toMatchObject({
      status: "completed",
      observation: { status: "ok", screenshot: { status: "available" } },
    });
    expect(
      await (a as any).page.locator("button").getAttribute("data-clicks"),
    ).toBe("1");
  } finally {
    await a.close();
    await f.close();
  }
});
it("allows same-document navigation without a path policy", async () => {
  const f = await startFixture(
    undefined,
    `<button onclick="history.pushState({},'', '/forbidden')">Leave path</button>`,
  );
  const a = await BrowserAdapter.create({ headless: true });
  try {
    const o = obs(
      await a.execute({ name: "navigate", input: { url: f.url + "/allowed" } }),
    );
    const controls = o.controls.status === "available" ? o.controls.items : [];
    const t = controls.find((x) => x.name === "Leave path")!;
    expect(
      (
        await a.execute({
          name: "click",
          input: {
            observation_id: o.observation_id,
            target: { kind: "control", control_ref: t.ref },
          },
        })
      ).result,
    ).toMatchObject({
      status: "completed",
      observation: { surface: { url: f.url + "/forbidden" } },
    });
  } finally {
    await a.close();
    await f.close();
  }
});
it("point input rejects layout drift inside an unchanged iframe", async () => {
  const f = await startFixture(
    undefined,
    `<button onclick="setTimeout(()=>document.querySelector('iframe').contentDocument.body.style.marginTop='80px',300)">Shift frame content</button><iframe src='/frame'></iframe>`,
  );
  const a = await BrowserAdapter.create({
    headless: true,
  });
  try {
    let o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    const c =
      o.controls.status === "available"
        ? o.controls.items.find((x) => x.name === "Shift frame content")
        : undefined;
    o = obs(
      await a.execute({
        name: "click",
        input: {
          observation_id: o.observation_id,
          target: { kind: "control", control_ref: c!.ref },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(
      (
        await a.execute({
          name: "click",
          input: {
            observation_id: o.observation_id,
            target: { kind: "point", x: 300, y: 40 },
          },
        })
      ).result,
    ).toMatchObject({ status: "blocked", code: "LAYOUT_CHANGED" });
  } finally {
    await a.close();
    await f.close();
  }
});
it("point typing cannot reuse previously focused input when clicked surface prevents focus", async () => {
  const f = await startFixture(
    undefined,
    `<label>Entry<input></label><div style="position:absolute;left:500px;top:30px;width:150px;height:100px" onmousedown="event.preventDefault()">Uneditable surface</div>`,
  );
  const a = await BrowserAdapter.create({
    headless: true,
  });
  try {
    let o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    const c =
      o.controls.status === "available"
        ? o.controls.items.find(
            (x) => x.name === "Entry" && x.role === "textbox",
          )
        : undefined;
    o = obs(
      await a.execute({
        name: "type_text",
        input: {
          observation_id: o.observation_id,
          target: { kind: "control", control_ref: c!.ref },
          mode: "replace",
          text: "safe",
        },
      }),
    );
    expect(
      (
        await a.execute({
          name: "type_text",
          input: {
            observation_id: o.observation_id,
            target: { kind: "point", x: 550, y: 60 },
            mode: "replace",
            text: "WRONG",
          },
        })
      ).result,
    ).toMatchObject({ status: "blocked" });
  } finally {
    await a.close();
    await f.close();
  }
});
it("pending input timeout prevents a later write or retry", async () => {
  const f = await startFixture(
    undefined,
    `<label>Entry<input oninput="const end=Date.now()+350;while(Date.now()<end){}"></label>`,
  );
  const a = await BrowserAdapter.create({
    headless: true,
    actionMs: 75,
  });
  try {
    const o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    const c =
      o.controls.status === "available"
        ? o.controls.items.find(
            (x) => x.name === "Entry" && x.role === "textbox",
          )
        : undefined;
    const action = {
      name: "type_text" as const,
      input: {
        observation_id: o.observation_id,
        target: { kind: "control" as const, control_ref: c!.ref },
        mode: "append" as const,
        text: "x",
      },
    };
    expect((await a.execute(action)).result.status).toBe("uncertain");
    expect((await a.execute(action)).result.status).toBe("needs_intervention");
  } finally {
    await a.close();
    await f.close();
  }
});
it("password conditions never expose values in evidence", async () => {
  const f = await startFixture(
    undefined,
    '<label>Password<input type="password" value="SAMPLE_SECRET"></label>',
  );
  const a = await BrowserAdapter.create({
    headless: true,
  });
  try {
    const o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    const c =
      o.controls.status === "available"
        ? o.controls.items.find(
            (x) => x.name === "Password" && x.role === "textbox",
          )
        : undefined;
    const r = await a.execute({
      name: "check_ui",
      input: {
        observation_id: o.observation_id,
        target: { kind: "control", control_ref: c!.ref },
        condition: { kind: "value_equals", expected: "wrong" },
      },
    });
    expect(JSON.stringify(r.result).includes("SAMPLE_SECRET")).toBe(false);
    expect(r.result).toMatchObject({ verdict: "unknown" });
  } finally {
    await a.close();
    await f.close();
  }
});
it("all capture phases obey the trusted operation timeout", async () => {
  const f = await startFixture(
    undefined,
    '<button onclick="setTimeout(()=>{const end=Date.now()+1800;while(Date.now()<end){}},300)">Freeze briefly</button>',
  );
  const a = await BrowserAdapter.create({
    headless: true,
    captureMs: 100,
  });
  try {
    const o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    const c =
      o.controls.status === "available"
        ? o.controls.items.find((x) => x.name === "Freeze briefly")
        : undefined;
    await a.execute({
      name: "click",
      input: {
        observation_id: o.observation_id,
        target: { kind: "control", control_ref: c!.ref },
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    const start = performance.now();
    const capture = await a.capture("controls");
    expect(performance.now() - start).toBeLessThan(700);
    expect(capture.observation.status).toBe("error");
    expect(
      (await a.execute({ name: "observe_ui", input: { mode: "both" } })).result
        .status,
    ).toBe("needs_intervention");
  } finally {
    await a.close();
    await f.close();
  }
});
it("publishes native option labels under their observed select control", async () => {
  const f = await startFixture();
  const a = await BrowserAdapter.create({
    headless: true,
  });
  try {
    const o = obs(await a.execute({ name: "navigate", input: { url: f.url } }));
    const items = o.controls.status === "available" ? o.controls.items : [];
    const select = items.find(
      (c) => c.role === "combobox" && c.name === "Plan",
    );
    expect(
      items.some(
        (c) =>
          c.role === "option" &&
          c.name === "Premium" &&
          c.parent_ref === select?.ref,
      ),
    ).toBe(true);
  } finally {
    await a.close();
    await f.close();
  }
});
