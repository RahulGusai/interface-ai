import type { BrowserAdapterFactory } from "./surface.js";
import { BrowserAdapter } from "./browser/browser-adapter.js";
import type { BrowserOptions } from "../runtime/config.js";
export const createBrowserFactory = (
  options: Partial<BrowserOptions> = {},
): BrowserAdapterFactory => ({
  createForTask: (_input) => BrowserAdapter.create(options),
});
