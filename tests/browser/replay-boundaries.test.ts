import { evaluateCheck } from "../../src/replay/checks.js";
import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { startFixture } from "../helpers/fixture-server.js";
import { resolveTarget } from "../../src/replay/targets.js";
import { runReplay } from "../../src/replay/run-replay.js";
it("resolves only the named scoped duplicate from fresh captured ancestry", async () => {
  const fixture = await startFixture(
    undefined,
    '<section aria-label="Primary"><button>Search</button></section><section aria-label="Secondary"><button>Search</button></section><span aria-label="Status">Active</span>',
  );
  const adapter = await createBrowserFactory({ headless: true }).createForTask({
    goal: "test",
    targetUrl: fixture.url,
  });
  try {
    await adapter.execute({ name: "navigate", input: { url: fixture.url } });
    const capture = await adapter.capture("both");
    const context = {
      inputs: {},
      results: {},
      environment: { base_url: fixture.url },
    };
    const target = {
      kind: "semantic",
      role: "button",
      name: { kind: "literal", value: "Search" },
      exact: true,
      required_matches: 1,
      scope: null,
    } as const;
    expect(
      resolveTarget(target, capture, new Map(), context).diagnosis.reason,
    ).toBe("TARGET_AMBIGUOUS");
    const scoped = {
      ...target,
      scope: [
        { role: "document", name: "", exact: true as const },
        { role: "region", name: "Primary", exact: true as const },
      ],
    };
    expect(
      resolveTarget(scoped, capture, new Map(), context).target?.kind,
    ).toBe("control");
    const textCheck = evaluateCheck(
      {
        check_id: "rendered_status",
        kind: "control_text_equals",
        target: {
          kind: "semantic",
          role: "text",
          name: { kind: "literal", value: "Status" },
          exact: true,
          scope: null,
          required_matches: 1,
        },
        expected: { kind: "literal", value: "Active" },
      },
      capture,
      context,
    );
    expect(textCheck.verdict).toBe("pass");
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
it("bounds wait recovery and never retries a mutation", async () => {
  const definition = JSON.parse(
    await readFile(
      new URL("../fixtures/replay-member-desk/artifact.json", import.meta.url),
      "utf8",
    ),
  );
  definition.steps[0].pre_checks = [
    {
      check_id: "ready",
      kind: "control_visible",
      target: {
        kind: "semantic",
        role: "button",
        name: { kind: "literal", value: "Ready" },
        exact: true,
        scope: null,
        required_matches: 1,
      },
    },
  ];
  definition.steps[0].recoveries = [
    {
      recovery_id: "read_wait",
      on_check_id: "ready",
      kind: "wait",
      max_attempts: 2,
      delay_ms: 500,
    },
  ];
  const html = await readFile(
    new URL("../fixtures/replay-member-desk/index.html", import.meta.url),
    "utf8",
  );
  const fixture = await startFixture(
    undefined,
    html.replace(
      "</body>",
      '<script>setTimeout(()=>{const b=document.createElement("button");b.textContent="Ready";document.body.append(b)},650)</script></body>',
    ),
  );
  try {
    const events: any[] = [];
    const result = await runReplay(
      {
        artifact: { definition },
        inputs: { email: "demo@example.test" },
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
        adapterFactory: createBrowserFactory({ headless: true }),
      },
      {
        onAudit: async (type, payload, image, step) => {
          events.push({ type, payload, step });
        },
      },
    );
    expect(result.status).toBe("success");
    const recoveries = events.filter((e) => e.type === "recovery_started");
    expect(recoveries.length).toBeGreaterThan(0);
    expect(recoveries.length).toBeLessThanOrEqual(2);
    expect(
      events.filter((e) => e.type === "tool_started" && e.step === "s001"),
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
