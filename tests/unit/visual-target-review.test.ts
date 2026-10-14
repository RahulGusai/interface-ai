import { expect, it } from "vitest";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { resolveStepTargets } from "../../src/replay/target-review.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import type { Capture } from "../../src/contracts/observation.js";
function images(duplicate: boolean) {
  const shot = new PNG({ width: 1280, height: 800 }),
    crop = new PNG({ width: 32, height: 32 });
  shot.data.fill(255);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4;
      crop.data[i] = (x * 53 + y * 19) % 256;
      crop.data[i + 1] = (y * 61 + x * 17) % 256;
      crop.data[i + 2] = (x * 29 + y * 47) % 256;
      crop.data[i + 3] = 255;
    }
  if (duplicate)
    for (const left of [70, 500])
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++)
          crop.data.copy(
            shot.data,
            ((y + 90) * 1280 + x + left) * 4,
            (y * 32 + x) * 4,
            (y * 32 + x) * 4 + 4,
          );
  return { shot: PNG.sync.write(shot), crop: PNG.sync.write(crop) };
}
it.each([true, false])(
  "reviews screenshot-only visual targets with duplicate matches: %s",
  async (duplicate) => {
    const { shot, crop } = images(duplicate);
    let n = 0;
    let reviews = 0;
    const capture = async (): Promise<Capture> => ({
      observation: {
        status: "ok",
        observation_id: `o${++n}`,
        captured_at: new Date().toISOString(),
        surface: { id: "browser", kind: "browser", title: "visual" },
        screenshot: {
          status: "available",
          image_ref: `i${n}`,
          width: 1280,
          height: 800,
        },
        controls: { status: "unavailable" },
      },
      image: { ref: `i${n}`, mimeType: "image/png", bytes: shot },
    });
    const prepare = resolveStepTargets({
      call_id: "call",
      specs: [
        {
          target: {
            kind: "visual",
            asset_id: "ref",
            sha256: createHash("sha256").update(crop).digest("hex"),
            matcher: "rgb-template-v1",
            threshold: 0.95,
            required_matches: 1,
            relative_point: { u: 0.5, v: 0.5 },
            capture_context: {
              viewport_width: 1280,
              viewport_height: 800,
              device_scale_factor: 1,
              image_scale: "css",
              color_space: "srgb",
            },
          },
        },
      ],
      capture: await capture(),
      fresh: capture,
      adapter: makeFakeAdapter(),
      assets: new Map([["ref", crop]]),
      bindings: {
        inputs: {},
        results: {},
        environment: { base_url: "https://example.org" },
      },
      tool: "click",
      arguments: {},
      audit: async () => {},
      review: async (request) => {
        reviews++;
        expect(request.target_resolution!.candidates).toHaveLength(
          duplicate ? 2 : 0,
        );
        return duplicate
          ? {
              review_id: "r",
              status: "approved",
              selected_candidate_id:
                request.target_resolution!.candidates[1]!.id,
            }
          : { review_id: "r", status: "rejected" };
      },
    });
    if (duplicate)
      expect((await prepare).targets).toEqual([
        { kind: "point", x: 516, y: 106 },
      ]);
    else await expect(prepare).rejects.toThrow("HUMAN_REVIEW_REJECTED");
    expect(reviews).toBe(1);
  },
);
it("records a flat crop and resolves replay through an observed Save choice", async () => {
  const { recordDurableTarget } =
    await import("../../src/runtime/target-recorder.js");
  const png = new PNG({ width: 1280, height: 800 });
  png.data.fill(255);
  const bytes = PNG.sync.write(png);
  let n = 0;
  const capture = async (): Promise<Capture> => ({
    observation: {
      status: "ok",
      observation_id: `o${++n}`,
      captured_at: new Date().toISOString(),
      surface: { id: "browser", kind: "browser", title: "Flat" },
      screenshot: {
        status: "available",
        image_ref: `i${n}`,
        width: 1280,
        height: 800,
      },
      controls: {
        status: "available",
        items: [
          {
            ref: `save${n}`,
            role: "button",
            name: "Save",
            state: { enabled: true },
          },
        ],
      },
    },
    image: { ref: `i${n}`, mimeType: "image/png", bytes },
  });
  const initial = await capture();
  const recorded = recordDurableTarget(
    { kind: "point", x: 40, y: 40 },
    initial,
    {
      visual_reference: {
        rect: { left: 20, top: 20, width: 40, height: 40 },
        relative_point: { u: 0.5, v: 0.5 },
        description: "Flat panel around Save",
      },
    },
  );
  const adapter: any = makeFakeAdapter();
  adapter.targetBounds = async () => ({ x: 20, y: 20, width: 80, height: 30 });
  expect(recorded.target.kind).toBe("visual");
  const prepared = await resolveStepTargets({
    call_id: "call",
    specs: [{ target: recorded.target }],
    capture: initial,
    fresh: capture,
    adapter,
    assets: new Map([
      [
        recorded.target.kind === "visual" ? recorded.target.asset_id : "",
        recorded.crop!,
      ],
    ]),
    bindings: {
      inputs: {},
      results: {},
      environment: { base_url: "https://example.org" },
    },
    tool: "click",
    arguments: {},
    audit: async () => {},
    review: async (request) => {
      expect(request.target_resolution!.reason).toBe("not_found");
      expect(request.target_resolution!.candidates[0]!.label).toContain("Save");
      return {
        review_id: "r",
        status: "approved",
        selected_candidate_id: request.target_resolution!.candidates[0]!.id,
      };
    },
  });
  expect(prepared.targets).toEqual([{ kind: "control", control_ref: "save2" }]);
});
it.each([
  { tool: "extract_data", role: "textbox", enabled: false },
  { tool: "click", role: "cell", enabled: true },
])(
  "offers compatible matched controls for $tool / $role / enabled=$enabled",
  async ({ tool, role, enabled }) => {
    let n = 0;
    const capture = async (): Promise<Capture> => ({
      observation: {
        status: "ok",
        observation_id: `o${++n}`,
        captured_at: new Date().toISOString(),
        surface: { id: "browser", kind: "browser", title: "Review" },
        screenshot: {
          status: "available",
          image_ref: `i${n}`,
          width: 1280,
          height: 800,
        },
        controls: {
          status: "available",
          items: [0, 1].map((i) => ({
            ref: `ref${n}-${i}`,
            role,
            name: "Details",
            value: `value${i}`,
            state: { enabled },
          })),
        },
      },
      image: {
        ref: `i${n}`,
        mimeType: "image/png",
        bytes: Buffer.from("same screen"),
      },
    });
    const adapter: any = makeFakeAdapter();
    adapter.targetBounds = async () => ({
      x: 20,
      y: 20,
      width: 80,
      height: 30,
    });
    const prepared = await resolveStepTargets({
      call_id: "call",
      specs: [
        {
          target: {
            kind: "semantic",
            role,
            name: { kind: "literal", value: "Details" },
            exact: true,
            scope: null,
            required_matches: 1,
          },
        },
      ],
      capture: await capture(),
      fresh: capture,
      adapter,
      assets: new Map(),
      bindings: {
        inputs: {},
        results: {},
        environment: { base_url: "https://example.org" },
      },
      tool,
      arguments: {},
      audit: async () => {},
      review: async (request) => {
        expect(request.target_resolution!.candidates).toHaveLength(2);
        return {
          review_id: "r",
          status: "approved",
          selected_candidate_id: request.target_resolution!.candidates[1]!.id,
        };
      },
    });
    expect(prepared.targets).toEqual([
      { kind: "control", control_ref: "ref2-1" },
    ]);
  },
);
