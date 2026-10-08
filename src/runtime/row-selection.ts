import type { Control } from "../contracts/observation.js";

const normalize = (value: unknown) => String(value).replace(/\s+/g, " ").trim();

export function rowMatchesValues(
  row: Control,
  controls: Control[],
  values: Record<string, unknown>,
): boolean {
  const candidates = controls
    .filter(
      (control) =>
        control.parent_ref === row.ref &&
        ["cell", "text", "rowheader", "columnheader"].includes(control.role),
    )
    .flatMap((control) =>
      [control.text, control.name]
        .filter((value): value is string => typeof value === "string")
        .map(normalize),
    );
  if (!candidates.length) candidates.push(normalize(row.text ?? row.name));
  return Object.values(values).every((value) => {
    if (
      value &&
      typeof value === "object" &&
      "operator" in value &&
      "value" in value
    ) {
      const expected = normalize(value.value);
      return (
        value.operator === "ends_with" &&
        expected.length > 0 &&
        candidates.some((candidate) => candidate.endsWith(expected))
      );
    }
    return (
      ["string", "number", "boolean"].includes(typeof value) &&
      candidates.includes(normalize(value))
    );
  });
}
