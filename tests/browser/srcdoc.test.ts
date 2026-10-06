import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { syntheticPolicy } from "../../src/runtime/policy.js";
import { startFixture } from "../helpers/fixture-server.js";

it("captures inline statement frames only when explicitly permitted under an allowed parent", async () => {
  const f = await startFixture(
    undefined,
    `<h1>Overview</h1><iframe title="Statement" srcdoc="<p>Statement value 123</p>"></iframe>`,
  );
  try {
    for (const enabled of [true, false]) {
      const policy = syntheticPolicy(f.url);
      policy.config.allowSrcdocFrames = enabled;
      const adapter = await BrowserAdapter.create(policy, { headless: true });
      try {
        const result = (
          await adapter.execute({ name: "navigate", input: { url: f.url } })
        ).result;
        expect(result.status).toBe(enabled ? "completed" : "blocked");
        if (
          enabled &&
          "observation" in result &&
          result.observation.status === "ok" &&
          result.observation.controls.status === "available"
        )
          expect(
            result.observation.controls.items.some(
              (c) => c.name === "Statement value 123",
            ),
          ).toBe(true);
      } finally {
        await adapter.close();
      }
    }
  } finally {
    await f.close();
  }
});
