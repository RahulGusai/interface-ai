import { createBrowserFactory as productionFactory } from "../../src/adapters/factory.js";
import type { BrowserAdapterFactory } from "../../src/adapters/surface.js";
import type { BrowserOptions } from "../../src/runtime/config.js";
import type { TrustedActionRule } from "../../src/adapters/browser/action-rules.js";
/** The historical local fixtures use UI events only to filter, select, or reveal
 * in-memory synthetic data. Keep that explicit test trust separate from runtime
 * defaults. Adversarial policy tests use their own narrowly enumerated rules. */
export function createBrowserFactory(
  options: Partial<BrowserOptions> = {},
): BrowserAdapterFactory {
  return {
    async createForTask(input) {
      const origin = new URL(input.targetUrl).origin;
      if (new URL(origin).hostname !== "127.0.0.1")
        throw Error("Local fixture only");
      const rules: TrustedActionRule[] = [
        "click",
        "type_text",
        "select_option",
        "press_key",
        "scroll",
      ].map((action) => ({
        id: "Local synthetic fixture UI handler",
        origin,
        pathname: /^\/(search)?$/,
        action: action as TrustedActionRule["action"],
        selector:
          'input, button, select, a, [role="combobox"], [role="option"], th, [role="columnheader"]',
        category: "read",
      }));
      return productionFactory({
        ...options,
        trustedActionRules: rules,
      }).createForTask(input);
    },
  };
}
