import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
let base = "",
  foreign = "",
  writes = 0;
const server = createServer((req, res) => {
  if (req.url === "/write") {
    writes++;
    res.end("saved");
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: foreign + "/profile" });
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/dialog") {
    res.end("<script>confirm('Continue?')</script><p>Dialog completed</p>");
    return;
  }
  res.end(
    `<label>Customer name<input id="name"></label><button onclick="document.querySelector('p').textContent='Profile '+document.querySelector('input').value">Search</button><button style="position:absolute;left:10px;top:300px;width:100px;height:40px" onclick="fetch('/write',{method:'POST'}).then(()=>document.querySelector('p').textContent='Saved')">Save</button><p>Ready</p>`,
  );
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  base = `http://127.0.0.1:${port}`;
  foreign = `http://localhost:${port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
function observation(response: ToolResponse) {
  const o =
    "observation" in response.result
      ? response.result.observation
      : response.result;
  if (o.status !== "ok" || o.controls.status !== "available")
    throw Error(JSON.stringify(response.result));
  return o;
}
it("production READ_ONLY search works with no trusted rules or assessment and still validates freshness", async () => {
  const adapter = await createBrowserFactory({ headless: true }).createForTask({
    goal: "Search",
    targetUrl: base,
    accessPolicy: "READ_ONLY",
  });
  const context = {
    adapter,
    accessPolicy: "READ_ONLY" as const,
    allowedHostname: "127.0.0.1",
    busy: false,
    halted: false,
  };
  const send = (name: string, input: unknown) =>
    dispatchTool(context, {
      id: name,
      name,
      argumentsJson: JSON.stringify(input),
    });
  try {
    const first = observation(await send("navigate", { url: base }));
    const target = (o: typeof first, name: string, role: string) => ({
      kind: "control",
      control_ref:
        o.controls.status === "available"
          ? o.controls.items.find((c) => c.name === name && c.role === role)!
              .ref
          : "",
    });
    const typed = observation(
      await send("type_text", {
        observation_id: first.observation_id,
        target: target(first, "Customer name", "textbox"),
        text: "Halima Achterberg",
        mode: "replace",
      }),
    );
    const stale = await send("click", {
      observation_id: first.observation_id,
      target: target(first, "Search", "button"),
    });
    expect(stale.result).toMatchObject({ code: "STALE_OBSERVATION" });
    const searched = observation(
      await send("click", {
        observation_id: typed.observation_id,
        target: target(typed, "Search", "button"),
      }),
    );
    expect(
      searched.controls.status === "available" &&
        searched.controls.items.some(
          (c) => c.text === "Profile Halima Achterberg",
        ),
    ).toBe(true);
    const before = writes;
    const saved = await send("click", {
      observation_id: searched.observation_id,
      target: { kind: "point", x: 40, y: 320 },
      execution: {
        decision: "requires_human_review",
        confidence: 0,
        reason: "write",
      },
    });
    expect(saved.result.status).toBe("completed");
    await new Promise((r) => setTimeout(r, 100));
    expect(writes).toBe(before + 1);
    expect(context.halted).toBe(false);
  } finally {
    await adapter.close();
  }
});
it.each(["direct", "redirect", "dialog"])(
  "READ_ONLY bypasses browser policy for %s",
  async (mode) => {
    const adapter = await createBrowserFactory({
      headless: true,
    }).createForTask({
      goal: "Inspect",
      targetUrl: base,
      accessPolicy: "READ_ONLY",
    });
    try {
      const url =
        mode === "direct"
          ? foreign + "/profile"
          : base + (mode === "redirect" ? "/redirect" : "/dialog");
      const response = await adapter.execute({
        name: "navigate",
        input: { url },
      });
      expect(response.result.status).toBe("completed");
      expect(adapter.policyViolation?.()).toBeUndefined();
      const o = observation(response);
      if (mode !== "dialog") expect(o.surface.url).toBe(foreign + "/profile");
      else
        expect(
          o.controls.status === "available" &&
            o.controls.items.some((c) => c.text === "Dialog completed"),
        ).toBe(true);
    } finally {
      await adapter.close();
    }
  },
);
