import type { BrowserContext, Frame, Page } from "playwright";
import {
  sameHostname,
  type AccessPolicy,
  type PolicyViolation,
} from "../../runtime/action-policy.js";

/** Inline child documents inherit their parent's navigation scope. Their about:
 * URL has no hostname; walk nested inline parents back to an allowed document.
 * Top-level about: URLs and other networkless schemes remain outside policy.
 */
function isAllowedInlineChild(frame: Frame, hostname: string): boolean {
  const parent = frame.parentFrame();
  if (!parent || !/^about:(blank|srcdoc)(?:[?#].*)?$/.test(frame.url()))
    return false;
  return (
    sameHostname(parent.url(), hostname) ||
    isAllowedInlineChild(parent, hostname)
  );
}
/** CDP pauses every document request, including every redirect hop. Context
 * routing covers a popup's initial request before its Page event is delivered.
 * Assets are deliberately not host-filtered. Service workers are disabled by the
 * adapter for policy runs so they cannot bypass interception.
 */
export async function installNavigationPolicy(
  context: BrowserContext,
  page: Page,
  hostname: string,
  policy: AccessPolicy,
  breach: (v: PolicyViolation) => void,
  unsupportedPage: () => void,
) {
  const reject = (url: string) => {
    if (sameHostname(url, hostname)) return false;
    breach({
      code: "DOMAIN_POLICY_VIOLATION",
      access_policy: policy,
      category: "unknown",
      reason: `Page navigation outside deployment hostname ${hostname}`,
      dispatch_state: "uncertain",
    });
    return true;
  };
  await context.route("**/*", async (route) => {
    if (route.request().isNavigationRequest()) {
      if (reject(route.request().url())) {
        await route.abort("blockedbyclient");
        return;
      }
      // Popups are unsupported. Deny the initial document request, not merely
      // the later Page event: an HTTP redirect can leave the host before that event.
      let belongsToPage = false;
      try {
        belongsToPage = route.request().frame().page() === page;
      } catch {
        /* popup has no frame yet */
      }
      if (!belongsToPage) {
        unsupportedPage();
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.continue();
  });
  const session = await context.newCDPSession(page);
  session.on("Fetch.requestPaused", (event) => {
    void (async () => {
      if (event.resourceType === "Document" && reject(event.request.url))
        await session.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        });
      else
        await session.send("Fetch.continueRequest", {
          requestId: event.requestId,
        });
    })().catch(() => {});
  });
  await session.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
    ],
  });
  page.on("framenavigated", (frame) => {
    // srcdoc/blank child frames are local to an allowed ancestor. Their later
    // HTTP navigations still pass through document/redirect interception above.
    if (isAllowedInlineChild(frame, hostname)) return;
    if (reject(frame.url())) void page.close().catch(() => {});
  });
}
