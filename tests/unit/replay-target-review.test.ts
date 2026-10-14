import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { runReplay } from "../../src/replay/run-replay.js";
import { SafeError } from "../../src/contracts/errors.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
const original = JSON.parse(
  await readFile(
    new URL("../fixtures/replay-member-desk/artifact.json", import.meta.url),
    "utf8",
  ),
);
async function scenario(
  review: any,
  missing: boolean | "empty" = false,
  configure?: (adapter: any) => void,
) {
  const adapter: any = makeFakeAdapter();
  const browserStop = new AbortController();
  const policyStop = new AbortController();
  let violation: any;
  adapter.reviewSignal = browserStop.signal;
  adapter.policySignal = policyStop.signal;
  adapter.policyViolation = () => violation;
  let version = 0;
  let controls: any[] =
    missing === "empty"
      ? []
      : missing
        ? [
            { role: "textbox", name: "Wrong", state: { enabled: true } },
            { role: "button", name: "Apply", state: { enabled: true } },
          ]
        : [1, 2].map(() => ({
            role: "button",
            name: "Search",
            state: { enabled: true },
          }));
  let screen = "same";
  adapter.capture = async () => {
    version++;
    return {
      observation: {
        status: "ok",
        observation_id: `obs${version}`,
        captured_at: new Date().toISOString(),
        surface: {
          id: "browser",
          kind: "browser",
          title: screen,
          url: "https://example.org/app",
        },
        screenshot: {
          status: "available",
          image_ref: `img${version}`,
          width: 1280,
          height: 800,
        },
        controls: {
          status: "available",
          items: controls.map((c, i) => ({ ...c, ref: `ref${version}-${i}` })),
        },
      },
      image: {
        ref: `img${version}`,
        mimeType: "image/png",
        bytes: Buffer.from(screen),
      },
    };
  };
  adapter.targetBounds = async (target: any) => ({
    x: Number(target.control_ref.split("-").at(-1)) * 100,
    y: 20,
    width: 80,
    height: 30,
  });
  adapter.isCurrentObservation = (id: string) => id === `obs${version}`;
  const definition = structuredClone(original);
  definition.steps = [definition.steps[1]];
  definition.entry.checks = [];
  definition.success_checks = [
    {
      check_id: "done",
      kind: "tool_status_equals",
      step_id: "s002",
      expected: "completed",
    },
  ];
  definition.business_outcomes = [];
  definition.output_mapping = {};
  definition.input_schema = definition.output_schema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  configure?.(adapter);
  const events: any[] = [];
  const result = await runReplay(
    {
      artifact: { definition },
      inputs: {},
      deployment: {
        app_deployment_id: "test",
        base_url: "https://example.org/app",
        config_version: 1,
        product_id: "desk",
        ui_variant: "standard",
        vendor_release: null,
      },
      assets: [],
      staging_directory: "/tmp",
    },
    { adapterFactory: { createForTask: async () => adapter } },
    {
      onAudit: async (type, payload) => {
        events.push({ type, payload });
      },
      review: async (request, signal) =>
        review(
          request,
          {
            setControls: (c: any[]) => (controls = c),
            setScreen: (s: string) => (screen = s),
            blockBrowser: () =>
              browserStop.abort(
                new SafeError(
                  "REVIEW_BROWSER_UNAVAILABLE",
                  "Browser cannot be reviewed",
                ),
              ),
            breachPolicy: () => {
              violation = {
                code: "DOMAIN_POLICY_VIOLATION",
                reason: "Left deployment hostname",
                dispatch_state: "not_dispatched",
                access_policy: "READ_WRITE",
                category: "unknown",
              };
              policyStop.abort(violation);
            },
          },
          signal,
        ),
    },
  );
  return { result, events, calls: adapter.calls };
}
it("keeps the pending call identity through selection and one dispatch", async () => {
  let callId = "";
  const r = await scenario((request: any) => {
    callId = request.call_id;
    return {
      review_id: "r",
      status: "approved",
      selected_candidate_id: request.target_resolution.candidates[1].id,
    };
  });
  expect(
    r.events.find(
      (e) => e.type === "tool_started" && e.payload.tool === "click",
    ).payload.call_id,
  ).toBe(callId);
  expect(
    r.events.find(
      (e) => e.type === "tool_finished" && e.payload.tool === "click",
    ).payload.call_id,
  ).toBe(callId);
});
it("offers missing-target alternatives compatible with the pending tool and dispatches the fresh selection once", async () => {
  const r = await scenario((request: any) => {
    expect(request.target_resolution.reason).toBe("not_found");
    expect(request.target_resolution.candidates).toHaveLength(1);
    expect(request.target_resolution.candidates[0].label).toContain("Apply");
    return {
      review_id: "r",
      status: "approved",
      selected_candidate_id: request.target_resolution.candidates[0].id,
    };
  }, true);
  expect(r.result.status).toBe("success");
  expect(r.calls.filter((c: any) => c.name === "click")).toHaveLength(1);
  expect(
    r.events.filter(
      (e) => e.type === "tool_started" && e.payload.tool === "click",
    ),
  ).toHaveLength(1);
});
it("refreshes empty choices and asks again even when the target becomes unique", async () => {
  let reviews = 0;
  const r = await scenario((request: any, state: any) => {
    reviews++;
    if (reviews === 1) {
      expect(request.target_resolution.candidates).toHaveLength(0);
      state.setControls([
        { role: "button", name: "Search", state: { enabled: true } },
      ]);
      return { review_id: "r1", status: "approved", refresh_targets: true };
    }
    return {
      review_id: "r2",
      status: "approved",
      selected_candidate_id: request.target_resolution.candidates[0].id,
    };
  }, "empty");
  expect(reviews).toBe(2);
  expect(r.result.status).toBe("success");
});
it("discards a choice when screen context changes and requests fresh candidates", async () => {
  let reviews = 0;
  let oldId = "";
  const r = await scenario((request: any, state: any) => {
    reviews++;
    if (reviews === 1) {
      oldId = request.target_resolution.candidates[0].id;
      state.setScreen("changed");
    } else expect(request.target_resolution.candidates[0].id).not.toBe(oldId);
    return {
      review_id: "r",
      status: "approved",
      selected_candidate_id: request.target_resolution.candidates[1].id,
    };
  });
  expect(reviews).toBe(2);
  expect(r.result.status).toBe("success");
});
it.each(["rejected", "expired", "cancelled"])(
  "%s review stops before action",
  async (status) => {
    const r = await scenario(() => ({ review_id: "r", status }));
    expect(r.result.code).toBe(`HUMAN_REVIEW_${status.toUpperCase()}`);
    expect(r.calls.filter((c: any) => c.name === "click")).toHaveLength(0);
  },
);
it("rejects IDs which were never offered", async () => {
  const r = await scenario(() => ({
    review_id: "r",
    status: "approved",
    selected_candidate_id: "invented",
  }));
  expect(r.result.code).toBe("HUMAN_REVIEW_PROTOCOL_ERROR");
  expect(r.calls.filter((c: any) => c.name === "click")).toHaveLength(0);
});
it("aborts a pending selection even when the reviewer ignores cancellation", async () => {
  const controller = new AbortController();
  const adapter: any = makeFakeAdapter();
  adapter.capture = async () => ({
    observation: {
      status: "ok",
      observation_id: "o",
      captured_at: new Date().toISOString(),
      surface: { id: "browser", kind: "browser", title: "" },
      screenshot: {
        status: "available",
        image_ref: "i",
        width: 1280,
        height: 800,
      },
      controls: { status: "available", items: [] },
    },
    image: { ref: "i", mimeType: "image/png", bytes: Buffer.from("screen") },
  });
  const def = structuredClone(original);
  def.entry.checks = [];
  def.steps = [def.steps[1]];
  def.success_checks = [
    {
      check_id: "done",
      kind: "tool_status_equals",
      step_id: "s002",
      expected: "completed",
    },
  ];
  def.business_outcomes = [];
  def.output_mapping = {};
  def.input_schema = def.output_schema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  const result = await runReplay(
    {
      artifact: { definition: def },
      inputs: {},
      deployment: {
        app_deployment_id: "test",
        base_url: "https://example.org",
        config_version: 1,
        product_id: "desk",
        ui_variant: "standard",
        vendor_release: null,
      },
      assets: [],
      staging_directory: "/tmp",
    },
    { adapterFactory: { createForTask: async () => adapter } },
    {
      signal: controller.signal,
      onAudit: async () => {},
      review: async () => {
        controller.abort();
        return new Promise(() => {});
      },
    },
  );
  expect(result.status).toBe("cancelled");
  expect(adapter.calls.filter((c: any) => c.name === "click")).toHaveLength(0);
});

it.each(["blockBrowser", "breachPolicy"])(
  "%s terminates a review even if the reviewer ignores its signal",
  async (kind) => {
    const r = await scenario((_request: any, state: any) => {
      state[kind]();
      return new Promise(() => {});
    });
    expect(r.result.code).toBe(
      kind === "blockBrowser"
        ? "REVIEW_BROWSER_UNAVAILABLE"
        : "DOMAIN_POLICY_VIOLATION",
    );
    expect(r.calls.filter((c: any) => c.name === "click")).toHaveLength(0);
  },
);

it("cancels even when candidate geometry never settles", async () => {
  const stop = new AbortController();
  const r = await scenario(
    () => {
      throw Error("review must not start");
    },
    false,
    (adapter) => {
      adapter.reviewSignal = stop.signal;
      adapter.targetBounds = () => {
        stop.abort(Error("REVIEW_BROWSER_UNAVAILABLE"));
        return new Promise(() => {});
      };
    },
  );
  expect(r.result.code).toBe("REVIEW_BROWSER_UNAVAILABLE");
  expect(r.calls.filter((c: any) => c.name === "click")).toHaveLength(0);
});
it("rebuilds a fresh capture after detached candidate geometry and asks for the current targets", async () => {
  let reads = 0;
  let reviewed = false;
  const r = await scenario(
    (request: any) => {
      reviewed = true;
      return {
        review_id: "r",
        status: "approved",
        selected_candidate_id: request.target_resolution.candidates[1].id,
      };
    },
    false,
    (adapter) => {
      const originalBounds = adapter.targetBounds;
      adapter.targetBounds = (target: any) => {
        reads++;
        if (reads === 1)
          throw new SafeError("REVIEW_TARGET_STALE", "Frame detached");
        return originalBounds(target);
      };
    },
  );
  expect(reviewed).toBe(true);
  expect(r.result.status).toBe("success");
});
it("bounds automatic rebuilding when geometry remains stale and offers refresh or reject", async () => {
  let reads = 0;
  const r = await scenario(
    (request: any) => {
      expect(request.target_resolution.candidates).toEqual([]);
      return { review_id: "r", status: "rejected" };
    },
    false,
    (adapter) => {
      adapter.targetBounds = async () => {
        reads++;
        throw new SafeError("REVIEW_TARGET_STALE", "Frame detached");
      };
    },
  );
  expect(r.result.code).toBe("HUMAN_REVIEW_REJECTED");
  expect(reads).toBe(3);
  expect(r.calls.filter((c: any) => c.name === "click")).toHaveLength(0);
});
