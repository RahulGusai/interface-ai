import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import type { ToolResponse } from "../../src/contracts/tools.js";

let base = "",
  foreign = "",
  foreignDocuments = 0;
const inline = (title: string, html: string) =>
  `<iframe title="${title}" srcdoc="${html.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"></iframe>`;
const server = createServer((req, res) => {
  if (req.headers.host?.startsWith("localhost")) {
    foreignDocuments++;
    res.end("Foreign document");
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: foreign + "/foreign" });
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/customers/C812347") {
    res.end(
      `<h1>Customer profile</h1>${inline("Statement summary", "<p>Statement value 123</p>")}`,
    );
  } else if (req.url === "/nested") {
    res.end(
      `<h1>Overview</h1>${inline("Outer", inline("Nested", "<p>Nested statement value</p>"))}`,
    );
  } else if (req.url === "/inline-external" || req.url === "/inline-redirect") {
    const target =
      req.url === "/inline-external"
        ? foreign + "/foreign"
        : base + "/redirect";
    res.end(
      inline(
        "Statement",
        `<script>location.href=${JSON.stringify(target)}</script>`,
      ),
    );
  } else if (req.url === "/top-blank") {
    res.end("<script>location.href='about:blank'</script>");
  } else {
    res.end("<a href='/customers/C812347'>Open customer</a>");
  }
});
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  foreign = `http://localhost:${port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
const assessment = {
  decision: "auto_approve",
  confidence: 0.9,
  reason: "Open customer profile",
};
it("READ_WRITE Open customer remains on the allowed host when its statement uses srcdoc", async () => {
  const adapter = await createBrowserFactory({ headless: true }).createForTask({
    goal: "Open profile",
    targetUrl: base,
    accessPolicy: "READ_WRITE",
  });
  const context = {
    adapter,
    accessPolicy: "READ_WRITE" as const,
    allowedHostname: "127.0.0.1",
    busy: false,
    halted: false,
  };
  try {
    const first = observation(
      await dispatchTool(context, {
        id: "entry",
        name: "navigate",
        argumentsJson: JSON.stringify({ url: base, execution: assessment }),
      }),
    );
    const target = {
      kind: "control",
      control_ref:
        first.controls.status === "available"
          ? first.controls.items.find((c) => c.name === "Open customer")!.ref
          : "",
    };
    const response = await dispatchTool(context, {
      id: "open",
      name: "click",
      argumentsJson: JSON.stringify({
        observation_id: first.observation_id,
        target,
        execution: assessment,
      }),
    });
    expect(response.result.status).toBe("completed");
    const opened = observation(response);
    expect(opened.surface.url).toBe(base + "/customers/C812347");
    expect(
      opened.controls.status === "available" &&
        opened.controls.items.some((c) => c.name === "Statement value 123"),
    ).toBe(true);
    expect(adapter.policyViolation?.()).toBeUndefined();
    expect(context.halted).toBe(false);
  } finally {
    await adapter.close();
  }
});
it("nested srcdoc child frames inherit the allowed parent", async () => {
  const url = base + "/nested";
  const adapter = await createBrowserFactory({ headless: true }).createForTask({
    goal: "Inspect",
    targetUrl: url,
    accessPolicy: "READ_WRITE",
  });
  try {
    const response = await adapter.execute({
      name: "navigate",
      input: { url },
    });
    expect(response.result.status).toBe("completed");
    const o = observation(response);
    expect(
      o.controls.status === "available" &&
        o.controls.items.some((c) => c.name === "Nested statement value"),
    ).toBe(true);
    expect(adapter.policyViolation?.()).toBeUndefined();
  } finally {
    await adapter.close();
  }
});
it.each(["/inline-external", "/inline-redirect", "/top-blank"])(
  "inline documents cannot bypass READ_WRITE navigation policy through %s",
  async (path) => {
    const url = base + path;
    const adapter = await createBrowserFactory({
      headless: true,
    }).createForTask({
      goal: "Inspect",
      targetUrl: url,
      accessPolicy: "READ_WRITE",
    });
    const before = foreignDocuments;
    try {
      const response = await adapter.execute({
        name: "navigate",
        input: { url },
      });
      expect(response.result).toMatchObject({
        code: "DOMAIN_POLICY_VIOLATION",
      });
      expect(foreignDocuments).toBe(before);
    } finally {
      await adapter.close();
    }
  },
);
