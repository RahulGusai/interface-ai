import type { BrowserContext } from "playwright";
import type { RuntimePolicy } from "../../runtime/policy.js";
import type { EventState } from "./events.js";
export async function installNavigationGuard(
  context: BrowserContext,
  policy: RuntimePolicy,
  state: EventState,
) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const document = request.isNavigationRequest();
    const block = () => {
      state.blocked = {
        kind: "policy",
        message: "Browser destination denied by trusted policy",
      };
      state.notify();
      return route.abort("blockedbyclient").catch(() => {});
    };
    if (!policy.allowUrl(request.url(), !document)) return block();
    try {
      if (document) {
        // Inspect redirect location without following it; the forbidden server is never contacted.
        const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        const location = response.headers().location;
        if (
          location &&
          response.status() >= 300 &&
          response.status() < 400 &&
          !policy.allowUrl(new URL(location, request.url()).href)
        ) {
          await response.dispose();
          return block();
        }
        await route.fulfill({ response });
        await response.dispose();
      } else await route.continue();
    } catch {
      await route.abort().catch(() => {});
    }
  });
  // WebSockets are not needed by the synthetic demo and do not bypass the resource policy.
  await context.routeWebSocket("**/*", (socket) => {
    socket.close();
  });
}
