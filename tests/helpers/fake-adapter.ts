import type { BrowserAdapterPort } from "../../src/adapters/surface.js";
import type { BrowserAction } from "../../src/contracts/tools.js";
import type { Capture } from "../../src/contracts/observation.js";
export function makeFakeAdapter() {
  let n = 0;
  const calls: BrowserAction[] = [];
  let closed = false;
  let current = "";
  const capture = async (): Promise<Capture> => {
    current = `obs_${++n}`;
    return {
      observation: {
        status: "ok",
        observation_id: current,
        captured_at: new Date().toISOString(),
        surface: {
          id: "surface",
          kind: "browser",
          title: "Synthetic",
          url: "https://example.org/app",
        },
        screenshot: { status: "not_requested" },
        controls: { status: "available", items: [] },
      },
    };
  };
  return {
    kind: "browser" as const,
    capabilities: new Set(["navigate", "observe_ui", "click"]),
    calls,
    get closed() {
      return closed;
    },
    capture,
    isCurrentObservation: (id: string) => id === current,
    async execute(action: BrowserAction) {
      calls.push(action);
      const c = await capture();
      return {
        result:
          action.name === "observe_ui"
            ? c.observation
            : {
                status: "completed" as const,
                observation: c.observation,
                ...(action.name === "navigate"
                  ? { requested_url: action.input.url }
                  : {}),
              },
      };
    },
    async close() {
      closed = true;
    },
  } satisfies BrowserAdapterPort & { calls: BrowserAction[]; closed: boolean };
}
