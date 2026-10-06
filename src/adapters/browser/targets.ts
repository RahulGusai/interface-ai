import type { ElementHandle, Page } from "playwright";
import type { Control, Target } from "../../contracts/observation.js";
import { readSemantics } from "./capture.js";
import { SafeError } from "../../contracts/errors.js";
export type Element = ElementHandle<HTMLElement | SVGElement>;
export type Binding = {
  element: Element;
  control: Control;
  options?: string[];
};
export type Resolved =
  | { kind: "control"; binding: Binding }
  | { kind: "point"; x: number; y: number };
export async function layoutSignature(page: Page) {
  // Each frame is evaluated in its own context; parent boxes alone cannot detect iframe drift.
  const frames = page.frames();
  const signatures = [];
  for (const frame of frames)
    signatures.push(
      await frame.evaluate(() => ({
        url: location.href,
        width: innerWidth,
        height: innerHeight,
        scrollX,
        scrollY,
        boxes: Array.from(document.querySelectorAll("body *")).map((e) => {
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height, e.scrollLeft, e.scrollTop];
        }),
      })),
    );
  if (frames.length !== page.frames().length)
    throw new SafeError("LAYOUT_CHANGED", "Frame tree changed");
  return JSON.stringify(signatures);
}
export async function resolve(
  page: Page,
  bindings: Map<string, Binding>,
  target: Target,
  signature: string,
): Promise<Resolved> {
  if (target.kind === "control") {
    const binding = bindings.get(target.control_ref);
    if (!binding)
      throw new SafeError("UNKNOWN_CONTROL", "Control reference is unknown");
    if (!(await binding.element.evaluate((e) => e.isConnected)))
      throw new SafeError("TARGET_MISSING", "Observed control was removed");
    const current = await readSemantics(binding.element);
    if (
      !current ||
      current.role !== binding.control.role ||
      current.name !== binding.control.name
    )
      throw new SafeError(
        "TARGET_CHANGED",
        "Observed control identity changed",
      );
    return { kind: "control", binding };
  }
  const size = page.viewportSize();
  if (!size || target.x >= size.width || target.y >= size.height)
    throw new SafeError("POINT_OUT_OF_BOUNDS", "Point is outside screenshot");
  if ((await layoutSignature(page)) !== signature)
    throw new SafeError("LAYOUT_CHANGED", "Layout changed; observe again");
  return target;
}
