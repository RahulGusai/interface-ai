// Evaluated in the element's own frame. Only explicit widget ownership is accepted.
export function selectionListbox(
  e: globalThis.Element,
): globalThis.Element | null {
  if (e.getAttribute("role") === "listbox") return e;
  if (e.getAttribute("role") !== "combobox") return null;
  const ids = new Set(
    `${e.getAttribute("aria-controls") ?? ""} ${e.getAttribute("aria-owns") ?? ""}`
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  const lists = [...ids]
    .map((id) => e.ownerDocument.getElementById(id))
    .filter((node) => node?.getAttribute("role") === "listbox");
  return lists.length === 1 ? lists[0]! : null;
}

export function matchingLabels(
  labels: string[],
  label: string,
  match: "exact" | "contains" | "ends_with",
) {
  if (!label) return [];
  if (match === "exact" && labels.includes(label))
    return labels.filter((value) => value === label);
  const expected = label.toLowerCase();
  return labels.filter((value) =>
    match === "contains"
      ? value.toLowerCase().includes(expected)
      : match === "ends_with"
        ? value.toLowerCase().endsWith(expected)
        : value.toLowerCase() === expected,
  );
}
