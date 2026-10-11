import type { BrowserAdapterFactory } from "./surface.js";
import { BrowserAdapter } from "./browser/browser-adapter.js";
import type { BrowserOptions } from "../runtime/config.js";
export const createBrowserFactory = (
  options: Partial<BrowserOptions> = {},
): BrowserAdapterFactory => ({
  createForTask: (input) =>
    BrowserAdapter.create({
      ...options,
      runPolicy: {
        baseUrl: input.targetUrl,
        accessPolicy: input.accessPolicy ?? "READ_ONLY",
      },
    }),
});
