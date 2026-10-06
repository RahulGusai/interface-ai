import type { BrowserContext, Page, Frame } from "playwright";
import type { RuntimePolicy } from "../../runtime/policy.js";
import type { DialogEvent } from "../../contracts/errors.js";
export type EventState = {
  generation: number;
  blocked?: { kind: string; message: string };
  dialogs: DialogEvent[];
  notify: () => void;
  closed: boolean;
};
/** Inline child documents inherit an allowed parent; never permit them as destinations. */
export function isAllowedFrame(frame: Frame, policy: RuntimePolicy): boolean {
  if (policy.allowUrl(frame.url())) return true;
  const parent = frame.parentFrame();
  return (
    !!policy.config.allowSrcdocFrames &&
    frame.url() === "about:srcdoc" &&
    !!parent &&
    isAllowedFrame(parent, policy)
  );
}
export function installEvents(
  context: BrowserContext,
  page: Page,
  policy: RuntimePolicy,
  state: EventState,
) {
  page.on("framenavigated", (frame) => {
    state.generation++;
    if (!isAllowedFrame(frame, policy)) {
      state.blocked = {
        kind: "policy",
        message: "Resulting frame destination denied by trusted policy",
      };
      state.notify();
    }
  });
  page.on("framedetached", () => state.generation++);
  page.on("close", () => {
    state.closed = true;
    state.generation++;
  });
  page.on("dialog", (dialog) => {
    void (async () => {
      const rule = policy.dialog(dialog.type(), dialog.message());
      const event: DialogEvent = {
        type: dialog.type(),
        message: policy.text(dialog.message()),
        decision: rule.decision,
        action:
          rule.decision === "accept"
            ? "accepted"
            : rule.decision === "dismiss"
              ? "dismissed"
              : "pending",
      };
      state.dialogs.push(event);
      if (rule.decision === "intervention") {
        state.blocked = {
          kind: "intervention",
          message: "Unrecognized native dialog requires intervention",
        };
        state.notify();
        return;
      }
      try {
        if (rule.decision === "accept") await dialog.accept(rule.promptText);
        else await dialog.dismiss();
      } catch {
        state.blocked = {
          kind: "intervention",
          message: "Dialog could not be resolved",
        };
        state.notify();
      }
    })();
  });
  context.on("page", (popup) => {
    if (popup === page) return;
    state.blocked = {
      kind: "intervention",
      message: "Additional pages are unsupported",
    };
    state.notify();
    void popup.close().catch(() => {});
  });
}
