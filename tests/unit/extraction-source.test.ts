import { expect, it } from "vitest";
import { isReusableExtractionSource } from "../../src/runtime/extraction-source.js";
it("excludes value-named summaries but retains labeled values and structured cells", () => {
  const control = {
    ref: "c",
    role: "text",
    name: "Credits $123.45 Debits $99.00",
    text: "Credits $123.45 Debits $99.00",
    state: {},
  };
  expect(isReusableExtractionSource(control)).toBe(false);
  expect(
    isReusableExtractionSource({
      ...control,
      role: "button",
      name: "Current balance",
      text: "$123.45",
    }),
  ).toBe(false);
  expect(
    isReusableExtractionSource({
      ...control,
      role: "link",
      name: "Account number",
      text: "012-9637106",
    }),
  ).toBe(false);
  expect(
    isReusableExtractionSource({
      ...control,
      name: "Current balance",
      text: "$123.45",
    }),
  ).toBe(true);
  expect(
    isReusableExtractionSource({
      ...control,
      role: "cell",
      table_cell: { columns: ["Balance"], column_index: 0, row_index: 0 },
    }),
  ).toBe(true);
  expect(
    isReusableExtractionSource({
      ...control,
      role: "textbox",
      name: "Start date",
      value: "2026-01-01",
      text: "",
    }),
  ).toBe(true);
});
