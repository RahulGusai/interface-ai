import { it, expect } from "vitest";
import { PNG } from "pngjs";
import { recordDurableTarget } from "../../src/runtime/target-recorder.js";
import type { Capture } from "../../src/contracts/observation.js";
it("uses correlated pre-action bytes and requires explicit crop bounds", () => {
  const png = new PNG({ width: 1280, height: 800 });
  png.data.fill(30);
  for (let y = 50; y < 90; y++)
    for (let x = 40; x < 80; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = (x * 53 + y * 19) % 256;
      png.data[i + 1] = (y * 61 + x * 17) % 256;
      png.data[i + 2] = (x * 29 + y * 47) % 256;
      png.data[i + 3] = 255;
    }
  const bytes = PNG.sync.write(png);
  const capture: Capture = {
    observation: {
      status: "ok",
      observation_id: "fresh",
      captured_at: new Date().toISOString(),
      surface: { id: "browser", kind: "browser", title: "fixture" },
      screenshot: {
        status: "available",
        image_ref: "before",
        width: 1280,
        height: 800,
      },
      controls: { status: "available", items: [] },
    },
    image: { ref: "before", mimeType: "image/png", bytes },
  };
  const target = { kind: "point", x: 60, y: 70 } as const;
  expect(() => recordDurableTarget(target, capture)).toThrow(
    "REFERENCE_BOUNDS_REQUIRED",
  );
  const recorded = recordDurableTarget(target, capture, {
    visual_reference: {
      rect: { left: 40, top: 50, width: 40, height: 40 },
      relative_point: { u: 0.5, v: 0.5 },
      description: "synthetic control",
    },
  });
  const crop = PNG.sync.read(recorded.crop!);
  expect(crop.width).toBe(40);
  expect(crop.data[0]).toBe(254);
  expect(JSON.stringify(recorded.target)).not.toContain("observation_id");
  expect(() =>
    recordDurableTarget(
      target,
      { ...capture, image: { ...capture.image!, ref: "after" } },
      {
        visual_reference: {
          rect: { left: 40, top: 50, width: 40, height: 40 },
          relative_point: { u: 0.5, v: 0.5 },
          description: "control",
        },
      },
    ),
  ).toThrow("REFERENCE_CAPTURE_REQUIRED");
});

function saveCapture(): Capture {
  return {
    observation: {
      status: "ok",
      observation_id: "fresh",
      captured_at: new Date().toISOString(),
      surface: { id: "browser", kind: "browser", title: "Contact" },
      screenshot: { status: "not_requested" },
      controls: {
        status: "available",
        items: ["top", "bottom"].map((ref) => ({
          ref,
          role: "button",
          name: "Save",
          text: "Save",
          state: { enabled: true },
          ancestry: [
            { role: "document", name: "", exact: true },
            { role: "form", name: "Edit contact details", exact: true },
          ],
        })),
      },
    },
  };
}

it("records the selected Save even when its durable description matches both buttons", () => {
  expect(
    recordDurableTarget(
      { kind: "control", control_ref: "bottom" },
      saveCapture(),
      undefined,
      undefined,
      { customer_name: "Halima Achterberg" },
    ),
  ).toMatchObject({ target: { kind: "semantic", name: { value: "Save" } } });
});

it("keeps same-name controls when their recorded scopes distinguish them", () => {
  const capture = saveCapture();
  if (
    capture.observation.status !== "ok" ||
    capture.observation.controls.status !== "available"
  )
    throw Error();
  capture.observation.controls.items[0]!.ancestry![1]!.name = "Other form";
  expect(
    recordDurableTarget({ kind: "control", control_ref: "bottom" }, capture)
      .target,
  ).toMatchObject({ kind: "semantic", name: { value: "Save" } });
});

it("records a geometrically valid point reference even when its crop is repeated", () => {
  const png = new PNG({ width: 1280, height: 800 });
  png.data.fill(255);
  for (const left of [40, 500])
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) {
        const i = ((y + 50) * png.width + x + left) * 4;
        png.data[i] = (x * 53 + y * 19) % 256;
        png.data[i + 1] = (y * 61 + x * 17) % 256;
        png.data[i + 2] = (x * 29 + y * 47) % 256;
        png.data[i + 3] = 255;
      }
  const capture = saveCapture();
  if (capture.observation.status !== "ok") throw Error();
  capture.observation.screenshot = {
    status: "available",
    image_ref: "before",
    width: 1280,
    height: 800,
  };
  capture.image = {
    ref: "before",
    mimeType: "image/png",
    bytes: PNG.sync.write(png),
  };
  expect(
    recordDurableTarget({ kind: "point", x: 60, y: 70 }, capture, {
      visual_reference: {
        rect: { left: 40, top: 50, width: 40, height: 40 },
        relative_point: { u: 0.5, v: 0.5 },
        description: "Save button",
      },
    }),
  ).toMatchObject({ target: { kind: "visual" } });
});
