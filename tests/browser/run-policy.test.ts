import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
import type { TrustedActionRule } from "../../src/adapters/browser/action-rules.js";
let url = "",
  external = "",
  writes = 0,
  foreignDocuments = 0,
  assets = 0;
const server = createServer((req, res) => {
  if (req.url === "/asset.js") {
    assets++;
    res.setHeader("Content-Type", "application/javascript");
    res.end("window.assetLoaded=true");
    return;
  }
  if (req.headers.host?.startsWith("localhost")) {
    foreignDocuments++;
    res.end("FOREIGN");
    return;
  }
  if (req.url === "/write") {
    writes++;
    res.end("ok");
    return;
  }
  if (req.url?.startsWith("/redirect")) {
    res.writeHead(302, {
      Location:
        req.url === "/redirect-chain" ? "/redirect" : external + "/foreign",
    });
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    `<script src='${external}/asset.js'></script><label>Search<input id='search'></label><button id='lookup' onclick="document.querySelector('p').textContent='Profile Ada'">Search</button><p>Ready</p><button id='save' onclick="fetch('/write',{method:'POST'})">Save</button><button id='unknown' onclick="fetch('/write',{method:'POST'})">Search</button><label>Record<input id='autosave' oninput="fetch('/write',{method:'POST'})"></label><a id='outside' href='${external}/foreign'>Outside</a><button id='popupRedirect' onclick="window.open('/redirect')">Popup redirect</button><button id='popup' onclick="window.open('${external}/foreign')">Popup</button>`,
  );
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  url = `http://127.0.0.1:${address.port}`;
  external = `http://localhost:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
function observation(r: ToolResponse) {
  const o = "observation" in r.result ? r.result.observation : r.result;
  if (o.status !== "ok") throw Error(JSON.stringify(r));
  return o;
}
function rules(): TrustedActionRule[] {
  return [
    ...["search", "lookup", "outside", "popup", "popupRedirect"].flatMap((id) =>
      ["click", "type_text"].map((action) => ({
        id,
        origin: url,
        pathname: /^\/$/,
        selector: "#" + id,
        action: action as "click" | "type_text",
        category: "read" as const,
      })),
    ),
    ...["save", "autosave"].flatMap((id) =>
      ["click", "type_text"].map((action) => ({
        id,
        origin: url,
        pathname: /^\/$/,
        selector: "#" + id,
        action: action as "click" | "type_text",
        category: "mutation" as const,
      })),
    ),
    {
      id: "redirect fixture",
      origin: url,
      pathname: /^\/redirect(-chain)?$/,
      action: "navigate",
      category: "read",
    },
  ];
}
async function setup(accessPolicy: "READ_ONLY" | "READ_WRITE" = "READ_ONLY") {
  const adapter = await BrowserAdapter.create({
    headless: true,
    runPolicy: { baseUrl: url, accessPolicy },
    trustedActionRules: rules(),
  });
  const response = await adapter.execute({ name: "navigate", input: { url } });
  return { adapter, observation: observation(response) };
}
it.each(["READ_ONLY", "READ_WRITE"] as const)(
  "known mutation is gated before dispatch under %s",
  async (policy) => {
    const { adapter, observation: o } = await setup(policy);
    const before = writes;
    try {
      if (o.controls.status !== "available") throw Error();
      const target = {
        kind: "control" as const,
        control_ref: o.controls.items.find((c) => c.name === "Save")!.ref,
      };
      const r = await adapter.execute({
        name: "click",
        input: { observation_id: o.observation_id, target },
      });
      expect(r.result.status).toBe(
        policy === "READ_ONLY" ? "policy_blocked" : "completed",
      );
      expect(writes - before).toBe(policy === "READ_ONLY" ? 0 : 1);
    } finally {
      await adapter.close();
    }
  },
);
it.each(["READ_ONLY", "READ_WRITE"] as const)(
  "a Search label cannot authorize an unknown effect under %s",
  async (policy) => {
    const { adapter, observation: o } = await setup(policy);
    const before = writes;
    try {
      if (o.controls.status !== "available") throw Error();
      const target = {
        kind: "control" as const,
        control_ref: o.controls.items
          .filter((c) => c.name === "Search" && c.role === "button")
          .at(-1)!.ref,
      };
      const r = await adapter.execute({
        name: "click",
        input: { observation_id: o.observation_id, target },
      });
      expect(r.result).toMatchObject({
        code: "ACCESS_POLICY_VIOLATION",
        policy: { category: "unknown" },
      });
      expect(writes).toBe(before);
    } finally {
      await adapter.close();
    }
  },
);
it("read-only search and profile retrieval work while external assets load", async () => {
  const { adapter, observation: first } = await setup();
  let o = first;
  const before = writes;
  try {
    const ref = (name: string, role: string) => {
      if (o.controls.status !== "available") throw Error();
      return {
        kind: "control" as const,
        control_ref: o.controls.items.find(
          (c) => c.name === name && c.role === role,
        )!.ref,
      };
    };
    o = observation(
      await adapter.execute({
        name: "type_text",
        input: {
          observation_id: o.observation_id,
          target: ref("Search", "textbox"),
          text: "Ada",
          mode: "replace",
        },
      }),
    );
    o = observation(
      await adapter.execute({
        name: "click",
        input: {
          observation_id: o.observation_id,
          target: ref("Search", "button"),
        },
      }),
    );
    const r = await adapter.execute({
      name: "extract_data",
      input: {
        observation_id: o.observation_id,
        fields: [
          {
            name: "profile",
            target: ref("Profile Ada", "text"),
            property: "text",
            output_type: "string",
          },
        ],
      },
    });
    expect(r.result).toMatchObject({
      fields: { profile: { value: "Profile Ada" } },
    });
    expect(writes).toBe(before);
    expect(assets).toBeGreaterThan(0);
  } finally {
    await adapter.close();
  }
});
it.each(["/redirect", "/redirect-chain", "link", "popup"])(
  "blocks off-host %s before a foreign document request",
  async (path) => {
    const { adapter, observation: o } = await setup();
    const before = foreignDocuments;
    try {
      const r = path.startsWith("/")
        ? await adapter.execute({
            name: "navigate",
            input: { url: url + path },
          })
        : await adapter.execute({
            name: "click",
            input: {
              observation_id: o.observation_id,
              target: {
                kind: "control",
                control_ref:
                  o.controls.status === "available"
                    ? o.controls.items.find(
                        (c) =>
                          c.name === (path === "link" ? "Outside" : "Popup"),
                      )!.ref
                    : "",
              },
            },
          });
      expect(r.result).toMatchObject({ code: "DOMAIN_POLICY_VIOLATION" });
      expect(foreignDocuments).toBe(before);
    } finally {
      await adapter.close();
    }
  },
);
it("typing into an autosaving record is blocked before input events", async () => {
  const { adapter, observation: o } = await setup();
  const before = writes;
  try {
    const r = await adapter.execute({
      name: "type_text",
      input: {
        observation_id: o.observation_id,
        target: {
          kind: "control",
          control_ref:
            o.controls.status === "available"
              ? o.controls.items.find(
                  (c) => c.name === "Record" && c.role === "textbox",
                )!.ref
              : "",
        },
        text: "Changed",
        mode: "replace",
      },
    });
    expect(r.result).toMatchObject({
      code: "ACCESS_POLICY_VIOLATION",
      policy: { category: "mutation" },
    });
    expect(writes).toBe(before);
  } finally {
    await adapter.close();
  }
});

import { runTask } from "../../src/runtime/run-task.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { runReplay } from "../../src/replay/run-replay.js";
import { startFixture } from "../helpers/fixture-server.js";
it("an asynchronous navigation breach terminates discovery while a model request is pending", async () => {
  const fixture = await startFixture(
    undefined,
    `<p>Waiting</p><script>setTimeout(()=>location.href='${external}/foreign',600)</script>`,
  );
  let adapter: BrowserAdapter | undefined;
  const events: unknown[] = [];
  try {
    const running = runTask(
      { goal: "Wait", targetUrl: fixture.url },
      {
        adapterFactory: {
          async createForTask(input) {
            return (adapter = await BrowserAdapter.create({
              headless: true,
              runPolicy: {
                baseUrl: input.targetUrl,
                accessPolicy: "READ_ONLY",
              },
            }));
          },
        },
        model: { model: "pending", complete: () => new Promise(() => {}) },
      },
      { onAudit: (r) => events.push(r) },
    );
    const result = await Promise.race([
      running,
      new Promise<{ status: string }>((r) =>
        setTimeout(() => r({ status: "timeout" }), 1800),
      ),
    ]);
    expect(result).toMatchObject({
      status: "policy_blocked",
      error: { code: "DOMAIN_POLICY_VIOLATION" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "policy_violation" }),
    );
  } finally {
    await adapter?.close();
    await fixture.close();
  }
});
it.each(["READ_ONLY", "READ_WRITE"] as const)(
  "saved replay re-evaluates the run policy %s",
  async (access_policy) => {
    const empty = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
    const before = writes;
    const events: unknown[] = [];
    const definition = {
      surface: "browser",
      compatibility: {
        product_id: "desk",
        ui_variant: "standard",
        vendor_release: null,
      },
      input_schema: empty,
      output_schema: empty,
      entry: { url: { kind: "environment", path: "base_url" }, checks: [] },
      steps: [
        {
          step_id: "save",
          execution: {
            decision: "requires_human_review",
            confidence: 1,
            reason: "Save record",
          },
          tool: "click",
          arguments: {},
          target: {
            kind: "semantic",
            role: "button",
            name: { kind: "literal", value: "Save" },
            exact: true,
            scope: null,
            required_matches: 1,
          },
          pre_checks: [],
          post_checks: [],
          recoveries: [],
        },
      ],
      success_checks: [
        {
          check_id: "saved",
          kind: "tool_status_equals",
          step_id: "save",
          expected: "completed",
        },
      ],
      business_outcomes: [],
      output_mapping: {},
    };
    const r = await runReplay(
      {
        access_policy,
        artifact: { definition },
        inputs: {},
        deployment: {
          app_deployment_id: "test",
          base_url: url,
          product_id: "desk",
          ui_variant: "standard",
          vendor_release: null,
          config_version: 1,
        },
        assets: [],
        staging_directory: "/tmp",
      },
      {
        adapterFactory: createBrowserFactory({
          headless: true,
          trustedActionRules: rules(),
        }),
      },
      {
        review: async () => ({ status: "approved", review_id: "test-review" }),
        onAudit: async (type, payload) => {
          events.push({ type, payload });
        },
      },
    );
    expect(r.status).toBe(
      access_policy === "READ_ONLY" ? "hard_failure" : "success",
    );
    if (access_policy === "READ_ONLY") {
      expect(r).toMatchObject({
        code: "ACCESS_POLICY_VIOLATION",
        dispatch_state: "not_dispatched",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_finished",
          payload: expect.objectContaining({
            result: expect.objectContaining({
              policy: expect.objectContaining({
                access_policy,
                category: "mutation",
              }),
            }),
          }),
        }),
      );
    }
    expect(writes - before).toBe(access_policy === "READ_ONLY" ? 0 : 1);
  },
);

it("unsupported popup is denied before even its same-host redirect can dispatch", async () => {
  const { adapter, observation: o } = await setup();
  const before = foreignDocuments;
  try {
    if (o.controls.status !== "available") throw Error();
    const r = await adapter.execute({
      name: "click",
      input: {
        observation_id: o.observation_id,
        target: {
          kind: "control",
          control_ref: o.controls.items.find(
            (c) => c.name === "Popup redirect",
          )!.ref,
        },
      },
    });
    expect(foreignDocuments).toBe(before);
    expect(r.result.status).not.toBe("completed");
  } finally {
    await adapter.close();
  }
});
it("discovery closes the browser before terminal audit can delay completion", async () => {
  const fixture = await startFixture(
    undefined,
    `<p>Waiting</p><script>setTimeout(()=>location.href='${external}/foreign',600)</script>`,
  );
  let adapter: BrowserAdapter | undefined;
  let terminalCapture = "";
  try {
    const result = await runTask(
      { goal: "Inspect", targetUrl: fixture.url },
      {
        adapterFactory: {
          async createForTask(input) {
            return (adapter = await BrowserAdapter.create({
              headless: true,
              runPolicy: {
                baseUrl: input.targetUrl,
                accessPolicy: "READ_ONLY",
              },
            }));
          },
        },
        model: {
          model: "scripted",
          async complete() {
            return {
              kind: "final_text",
              text: "Done",
              assistantMessage: { role: "assistant", content: "Done" },
            };
          },
        },
      },
      {
        onAudit: async (r) => {
          if (r.type === "run_finished") {
            terminalCapture = (await adapter!.capture("controls")).observation
              .status;
            await new Promise((r) => setTimeout(r, 850));
          }
        },
      },
    );
    expect(terminalCapture).toBe("error");
    expect(result.status).toBe("agent_stopped_unverified");
    expect(adapter?.policyViolation()).toBeUndefined();
  } finally {
    await adapter?.close();
    await fixture.close();
  }
});
it("a breach during business-outcome audit remains a replay failure", async () => {
  const fixture = await startFixture(
    undefined,
    `<button id='lookup' onclick="setTimeout(()=>location.href='${external}/foreign',400)">Search</button>`,
  );
  const empty = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  const events: unknown[] = [];
  const definition = {
    surface: "browser",
    compatibility: {
      product_id: "desk",
      ui_variant: "standard",
      vendor_release: null,
    },
    input_schema: empty,
    output_schema: empty,
    entry: { url: { kind: "environment", path: "base_url" }, checks: [] },
    steps: [
      {
        step_id: "lookup",
        tool: "click",
        arguments: {},
        target: {
          kind: "semantic",
          role: "button",
          name: { kind: "literal", value: "Search" },
          exact: true,
          scope: null,
          required_matches: 1,
        },
        pre_checks: [],
        post_checks: [],
        recoveries: [],
      },
    ],
    success_checks: [
      {
        check_id: "success",
        kind: "tool_status_equals",
        step_id: "lookup",
        expected: "failed",
      },
    ],
    business_outcomes: [
      {
        code: "empty",
        message: "No result",
        after_step_id: "lookup",
        checks: [
          {
            check_id: "business",
            kind: "tool_status_equals",
            step_id: "lookup",
            expected: "completed",
          },
        ],
        output_mapping: {},
      },
    ],
    output_mapping: {},
  };
  try {
    const result = await runReplay(
      {
        artifact: { definition },
        inputs: {},
        deployment: {
          app_deployment_id: "test",
          base_url: fixture.url,
          product_id: "desk",
          ui_variant: "standard",
          vendor_release: null,
          config_version: 1,
        },
        assets: [],
        staging_directory: "/tmp",
      },
      {
        adapterFactory: createBrowserFactory({
          headless: true,
          trustedActionRules: [
            {
              id: "Synthetic lookup",
              origin: fixture.url,
              pathname: /^\/$/,
              action: "click",
              selector: "#lookup",
              category: "read",
            },
          ],
        }),
      },
      {
        onAudit: async (type, payload) => {
          events.push({ type, payload });
          if (type === "check_finished" && payload.check_id === "business")
            await new Promise((r) => setTimeout(r, 700));
        },
      },
    );
    expect(result).toMatchObject({
      status: "hard_failure",
      code: "DOMAIN_POLICY_VIOLATION",
      outputs: null,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "policy_violation" }),
    );
  } finally {
    await fixture.close();
  }
});
it("networkless child documents cannot bypass the hostname policy", async () => {
  const fixture = await startFixture(
    undefined,
    "<iframe src='data:text/html,foreign document'></iframe>",
  );
  const adapter = await BrowserAdapter.create({
    headless: true,
    runPolicy: { baseUrl: fixture.url, accessPolicy: "READ_ONLY" },
  });
  try {
    expect(
      (await adapter.execute({ name: "navigate", input: { url: fixture.url } }))
        .result,
    ).toMatchObject({ code: "DOMAIN_POLICY_VIOLATION" });
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
it.each(["READ_ONLY", "READ_WRITE"] as const)(
  "unclassified native confirmation is never accepted under %s",
  async (accessPolicy) => {
    const fixture = await startFixture(
      undefined,
      `<script>if(confirm('Continue?'))fetch('${url}/write',{method:'POST',mode:'no-cors'});</script>`,
    );
    const adapter = await BrowserAdapter.create({
      headless: true,
      runPolicy: { baseUrl: fixture.url, accessPolicy },
    });
    const before = writes;
    try {
      const response = await adapter.execute({
        name: "navigate",
        input: { url: fixture.url },
      });
      expect(response.result).toMatchObject({
        code: "ACCESS_POLICY_VIOLATION",
        policy: { category: "unknown" },
      });
      expect(writes).toBe(before);
    } finally {
      await adapter.close();
      await fixture.close();
    }
  },
);
