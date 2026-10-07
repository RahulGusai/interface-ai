import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { startFixture } from "../helpers/fixture-server.js";

it("captures inline statement frames without a permission rule", async () => {
  const fixture = await startFixture(
    undefined,
    `<h1>Overview</h1><iframe title="Statement" srcdoc="<p>Statement value 123</p>"></iframe>`,
  );
  const adapter = await BrowserAdapter.create({ headless: true });
  try {
    const result = (
      await adapter.execute({ name: "navigate", input: { url: fixture.url } })
    ).result;
    expect(result.status).toBe("completed");
    if (
      !("observation" in result) ||
      result.observation.status !== "ok" ||
      result.observation.controls.status !== "available"
    )
      throw Error("No controls");
    expect(
      result.observation.controls.items.some(
        (c) => c.name === "Statement value 123",
      ),
    ).toBe(true);
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
