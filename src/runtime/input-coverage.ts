import type { DiscoveryContext } from "./discovery-context.js";
/** Successful, dispatched uses only; metadata or rejected proposals do not bind inputs. */
export function unusedDiscoveryInputs(context: DiscoveryContext): string[] {
  const used = new Set<string>();
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.kind === "input" && typeof value.path === "string") {
      used.add(value.path);
      return;
    }
    if (value.kind === "literal") return;
    Object.values(value).forEach(visit);
  };
  for (const record of context.records) {
    if (
      !(
        ["completed", "condition_met"].includes(record.result?.status) ||
        (record.result?.status === "evaluated" &&
          record.result?.verdict === "pass")
      ) ||
      record.result?.verdict === "fail" ||
      record.result?.verification === "mismatched"
    )
      continue;
    // Only locations resolved as bindings by the execution path count.
    const value = record.input;
    if (record.tool === "type_text") visit(value.text);
    if (record.tool === "select_option") visit(value.option?.label);
    if (["check_ui", "wait_for"].includes(record.tool))
      visit(value.condition?.expected);
    visit(value.row_match);
    if (record.tool === "extract_data")
      for (const field of value.fields ?? []) visit(field.row_match);
  }
  return Object.keys(context.metadata?.input_schema.properties ?? {}).filter(
    (path) => !used.has(path),
  );
}
