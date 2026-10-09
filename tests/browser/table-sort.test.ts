import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { startFixture } from "../helpers/fixture-server.js";
it("captures explicit table ordering and refuses conflicting or ambiguous indicators", async () => {
  const fixture = await startFixture(
    undefined,
    `<table aria-label="explicit"><tr><th>Date</th><th aria-sort="ascending">Amount</th></tr><tr><td>Jan 13</td><td>-$571.30</td></tr></table>
  <table aria-label="glyph"><tr><th>Date</th><th>Amount &#9660;</th></tr><tr><td>Jan 13</td><td>-$571.30</td></tr></table>
  <table aria-label="unknown"><tr><th>Date</th><th aria-sort="none">Amount ▲</th></tr><tr><td>Jan 13</td><td>-$571.30</td></tr></table>
  <table aria-label="ambiguous"><tr><th aria-sort="ascending">Date</th><th aria-sort="ascending">Amount</th></tr><tr><td>Jan 13</td><td>-$571.30</td></tr></table>`,
  );
  const adapter = await BrowserAdapter.create({ headless: true });
  try {
    const result = await adapter.execute({
      name: "navigate",
      input: { url: fixture.url },
    });
    const o = (result.result as any).observation;
    const cells = o.controls.items.filter(
      (c: any) => c.role === "cell" && c.table_cell.column_index === 0,
    );
    expect(cells.map((c: any) => c.table_cell.sort)).toEqual([
      { column_index: 1, direction: "ascending" },
      { column_index: 1, direction: "descending" },
      undefined,
      undefined,
    ]);
  } finally {
    await adapter.close();
    await fixture.close();
  }
});
