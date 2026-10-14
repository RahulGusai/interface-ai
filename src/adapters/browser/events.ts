import type { BrowserContext, Page } from "playwright";
import type { DialogEvent } from "../../contracts/errors.js";
export type EventState = {
  generation: number;
  blocked?: { kind: string; message: string };
  dialogs: DialogEvent[];
  notify: () => void;
  onBlock?: () => void;
  closed: boolean;
};
export function installEvents(
  context: BrowserContext,
  page: Page,
  state: EventState,
  onUnclassifiedDialog?: () => void,
) {
  page.on("framenavigated", () => {
    state.generation++;
  });
  page.on("framedetached", () => state.generation++);
  page.on("close", () => {
    state.closed = true;
    state.generation++;
    state.notify();
    state.onBlock?.();
  });
  page.on("dialog", (dialog) => {
    void (async () => {
      const event: DialogEvent = {
        type: dialog.type(),
        message: dialog.message(),
        decision: "accept",
        action: "accepted",
      };
      state.dialogs.push(event);
      if (onUnclassifiedDialog) {
        event.decision = "intervention";
        event.action = "pending";
        // Accepting or dismissing can resume application mutation code. Closing
        // the context terminates the script without making either decision.
        onUnclassifiedDialog();
        return;
      }
      try {
        await dialog.accept();
      } catch {
        state.blocked = {
          kind: "intervention",
          message: "Dialog could not be resolved",
        };
        state.notify();
        state.onBlock?.();
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
    state.onBlock?.();
    void popup.close().catch(() => {});
  });
}
