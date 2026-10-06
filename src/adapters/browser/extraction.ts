import type { Binding } from "./targets.js";
import { readSemantics } from "./capture.js";
export async function readProperty(
  binding: Binding | undefined,
  property: "text" | "value" | "name",
): Promise<string | undefined> {
  if (!binding) return undefined;
  if (!(await binding.element.evaluate((e) => e.isConnected))) return undefined;
  if (property === "name") return (await readSemantics(binding.element))?.name;
  return binding.element.evaluate((e, p) => {
    const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    if (
      !r.width ||
      !r.height ||
      s.visibility === "hidden" ||
      s.display === "none"
    )
      return undefined;
    if (p === "value")
      return e instanceof HTMLInputElement && e.type === "password"
        ? undefined
        : "value" in e
          ? String((e as HTMLInputElement).value)
          : undefined;
    return (e as HTMLElement).innerText?.replace(/\r\n?/g, "\n");
  }, property);
}
export function convertNumber(text: string): number | undefined {
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}
