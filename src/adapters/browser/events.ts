import type { BrowserContext, Page } from "playwright";
import type { DialogEvent } from "../../contracts/errors.js";
export type EventState = {
  generation: number;
  blocked?: { kind: string; message: string };
  dialogs: DialogEvent[];
  notify: () => void;
  closed: boolean;
};
export function installEvents(
  context: BrowserContext,
  page: Page,
  state: EventState,
) {
  page.on("framenavigated", () => {
    state.generation++;
  });
  page.on("framedetached", () => state.generation++);
  page.on("close", () => {
    state.closed = true;
    state.generation++;
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
      try {
        await dialog.accept();
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
