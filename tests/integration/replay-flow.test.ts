import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { startFixture } from "../helpers/fixture-server.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { runReplay } from "../../src/replay/run-replay.js";
const definition = JSON.parse(
  await readFile(
    new URL("../fixtures/replay-member-desk/artifact.json", import.meta.url),
    "utf8",
  ),
);
const html = await readFile(
  new URL("../fixtures/replay-member-desk/index.html", import.meta.url),
  "utf8",
);
it("replays two inputs and returns not-found before the missing link without a model", async () => {
  const fixture = await startFixture(undefined, html);
  try {
    for (const [email, status] of [
      ["demo@example.test", "Active"],
      ["other@example.test", "Pending"],
      ["missing@example.test", null],
    ]) {
      const events: any[] = [];
      const result = await runReplay(
        {
          artifact: { definition },
          inputs: { email },
          deployment: {
            app_deployment_id: "test",
            base_url: fixture.url,
            config_version: 1,
            product_id: "desk",
            ui_variant: "standard",
            vendor_release: null,
          },
          assets: [],
          staging_directory: "/tmp",
        },
        {
          adapterFactory: createBrowserFactory({ headless: true }),
        },
        {
          onAudit: async (type, payload, image, step_id) => {
            events.push({ type, payload, image, step_id });
          },
        },
      );
      expect(result.status).toBe(status ? "success" : "expected_outcome");
      if (status) expect(result.outputs).toEqual({ status });
      else {
        expect(result.code).toBe("not_found");
        expect(
          events.some((e) => e.type === "tool_started" && e.step_id === "s003"),
        ).toBe(false);
      }
      expect(
        events
          .filter((e) => e.type === "target_resolution_finished")
          .every((e) => e.image?.bytes.length > 0),
      ).toBe(true);
    }
  } finally {
    await fixture.close();
  }
}, 20000);
it("duplicate target stops before Search dispatch and persists fresh failure evidence", async () => {
  const fixture = await startFixture(
    undefined,
    html.replace("</body>", "<button>Search</button></body>"),
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
          config_version: 1,
          product_id: "desk",
          ui_variant: "standard",
          vendor_release: null,
        },
        assets: [],
        staging_directory: "/tmp",
      },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
      },
      {
        onAudit: async (type, payload, image, step_id) => {
          events.push({ type, payload, image, step_id });
        },
      },
    );
    expect(result.code).toBe("TARGET_AMBIGUOUS");
    expect(
      events.some((e) => e.type === "tool_started" && e.step_id === "s002"),
    ).toBe(false);
    expect(
      events.find(
        (e) =>
          e.type === "target_resolution_finished" &&
          e.payload.verdict === "failed",
      ).image.bytes.length,
    ).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});
