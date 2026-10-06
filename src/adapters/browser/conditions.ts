import type { Binding } from "./targets.js";
import type { ToolInputs } from "../../contracts/tools.js";
export type Evaluation = {
  verdict: "pass" | "fail" | "unknown";
  evidence?: { property: string; observed: string | boolean };
};
export const normalize = (s: string) => s.replace(/\r\n?/g, "\n");
export async function evaluateCondition(
  binding: Binding | undefined,
  condition: ToolInputs["check_ui"]["condition"],
): Promise<Evaluation> {
  if (!binding) return { verdict: "unknown" };
  try {
    return await binding.element.evaluate((e, c) => {
      const connected = e.isConnected;
      let value: string | boolean | undefined;
      if (c.kind === "visible" || c.kind === "hidden") {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        const visible =
          connected &&
          r.width > 0 &&
          r.height > 0 &&
          s.display !== "none" &&
          s.visibility !== "hidden";
        return {
          verdict: (c.kind === "visible" ? visible : !visible)
            ? "pass"
            : "fail",
          evidence: { property: "visible", observed: visible },
        };
      }
      if (!connected) return { verdict: "unknown" };
      if (c.kind === "enabled")
        value =
          !e.matches(":disabled") && e.getAttribute("aria-disabled") !== "true";
      if (c.kind === "text_equals")
        value = (e as HTMLElement).innerText?.replace(/\r\n?/g, "\n");
      if (
        c.kind === "value_equals" &&
        e instanceof HTMLInputElement &&
        e.type === "password"
      )
        return { verdict: "unknown" };
      if (c.kind === "value_equals" && "value" in e)
        value = String((e as HTMLInputElement).value).replace(/\r\n?/g, "\n");
      if (value === undefined) return { verdict: "unknown" };
      const expected =
        c.kind === "enabled" ? true : c.expected.replace(/\r\n?/g, "\n");
      return {
        verdict: value === expected ? "pass" : "fail",
        evidence: { property: c.kind, observed: value },
      };
    }, condition);
  } catch {
    return { verdict: "unknown" };
  }
}
