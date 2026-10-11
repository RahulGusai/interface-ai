import type { BrowserAction } from "../../contracts/tools.js";
import type { Classification } from "../../runtime/action-policy.js";
import type { Resolved } from "./targets.js";
/** Code-owned integration rules, never loaded from page text, tool args or artifacts.
 * A rule attests the application's event-handler effects, not a button's wording.
 * Scope to an exact origin, route, action, and selector; constrain arguments where
 * different keys/options change the effect. No matching rule means unknown.
 */
export type TrustedActionRule = {
  id: string;
  origin: string;
  pathname: RegExp;
  action: BrowserAction["name"];
  selector?: string;
  category: "read" | "mutation";
  accepts?: (action: BrowserAction) => boolean;
};
export async function classifyTargetAction(
  action: BrowserAction,
  url: string,
  target: Resolved | undefined,
  rules: readonly TrustedActionRule[],
): Promise<Classification> {
  const current = new URL(url);
  const matches: TrustedActionRule[] = [];
  for (const rule of rules) {
    rule.pathname.lastIndex = 0;
    if (
      rule.origin !== current.origin ||
      !rule.pathname.test(current.pathname) ||
      rule.action !== action.name ||
      (rule.accepts && !rule.accepts(action))
    )
      continue;
    if (rule.selector) {
      if (target?.kind !== "control") continue;
      const frame = await target.binding.element.ownerFrame();
      if (!frame || frame.url() !== url) continue;
      if (
        !(await target.binding.element.evaluate(
          (e, selector) => e.isConnected && e.matches(selector),
          rule.selector,
        ))
      )
        continue;
    } else if (action.name !== "navigate") continue;
    matches.push(rule);
  }
  if (
    matches.length &&
    matches.every((r) => r.category === matches[0]!.category)
  )
    return {
      category: matches[0]!.category,
      reason: `Trusted application rule: ${matches.map((r) => r.id).join(", ")}`,
    };
  return {
    category: "unknown",
    reason: "No unambiguous trusted rule for the current action and target",
  };
}
