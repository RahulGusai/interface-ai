import { expect, it } from "vitest";
import { recordDurableTarget } from "../../src/runtime/target-recorder.js";
import { resolveTarget } from "../../src/replay/targets.js";
import type { Capture } from "../../src/contracts/observation.js";
const capture = (direction = "ascending", row = 0): Capture => ({
  observation: {
    status: "ok",
    observation_id: "o",
    captured_at: new Date().toISOString(),
    surface: { id: "b", kind: "browser", title: "Transactions" },
    screenshot: { status: "not_requested" },
    controls: {
      status: "available",
      items: [
        {
          ref: "date",
          role: "cell",
          name: "2026-01-13",
          state: {},
          table_cell: {
            columns: ["Date", "Amount"],
            column_index: 0,
            row_index: row,
            sort: { column_index: 1, direction },
          } as any,
        },
      ],
    },
  },
});
const target = { kind: "control" as const, control_ref: "date" };
const rank = { column: "Amount", direction: "ascending", row_index: 0 };
it("rejects accidental positions and conflicting selection modes", () => {
  expect(() =>
    recordDurableTarget(target, capture(), undefined, undefined, {
      start: "2026-01-01",
    }),
  ).toThrow(/row_rank/);
  expect(() =>
    recordDurableTarget(
      target,
      capture(),
      undefined,
      { start: "2026-01-01" },
      {},
      rank,
    ),
  ).toThrow(/row_match/);
});
it("requires observed ordering and the requested visible rank", () => {
  expect(() =>
    recordDurableTarget(
      target,
      capture("descending"),
      undefined,
      undefined,
      {},
      rank,
    ),
  ).toThrow(/sort/);
  expect(() =>
    recordDurableTarget(
      target,
      capture("ascending", 3),
      undefined,
      undefined,
      {},
      rank,
    ),
  ).toThrow(/rank/);
  const unknown = capture();
  delete (unknown.observation as any).controls.items[0].table_cell.sort;
  expect(() =>
    recordDurableTarget(target, unknown, undefined, undefined, {}, rank),
  ).toThrow(/sort/);
});
it("persists ordering separately from extraction column and fails replay if it changes", () => {
  const saved = recordDurableTarget(
    target,
    capture(),
    undefined,
    undefined,
    {},
    rank,
  ).target;
  expect(saved).toMatchObject({
    kind: "table_cell",
    column_index: 0,
    row_index: 0,
    sort: { column_index: 1, direction: "ascending" },
  });
  const context = {
    inputs: {},
    results: {},
    environment: { base_url: "https://example.org" },
  };
  expect(resolveTarget(saved, capture(), new Map(), context).target).toEqual(
    target,
  );
  expect(
    resolveTarget(saved, capture("descending"), new Map(), context).target,
  ).toBeUndefined();
});

it("allows ranked output values coinciding with an input while retaining identity protection", () => {
  expect(() =>
    recordDurableTarget(
      target,
      capture(),
      undefined,
      undefined,
      { start_date: "2026-01-13" },
      rank,
    ),
  ).not.toThrow();
  expect(() =>
    recordDurableTarget(target, capture(), undefined, undefined, {
      start_date: "2026-01-13",
    }),
  ).toThrow(/identity/);
});
