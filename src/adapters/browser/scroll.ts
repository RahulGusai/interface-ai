import type { Page } from "playwright";
import type { Resolved, Element } from "./targets.js";
import { SafeError } from "../../contracts/errors.js";
export async function scroll(
  page: Page,
  target: Resolved | undefined,
  direction: string,
  distance: number,
) {
  let owned = false;
  let element: Element;
  if (target?.kind === "control") element = target.binding.element;
  else {
    const handle = await page.evaluateHandle(
      (p) => {
        if (!p) return document.scrollingElement;
        let e = document.elementFromPoint(p.x, p.y);
        while (e) {
          const s = getComputedStyle(e);
          if (/auto|scroll/.test(s.overflow + s.overflowX + s.overflowY))
            return e;
          e = e.parentElement;
        }
        return document.scrollingElement;
      },
      target?.kind === "point" ? { x: target.x, y: target.y } : null,
    );
    const e = handle.asElement();
    if (!e) throw new SafeError("UNSUPPORTED_SCROLL", "No scroll region");
    element = e as Element;
    owned = true;
  }
  try {
    const value = await element.evaluate(
      (e, args) => {
        const horizontal = ["left", "right"].includes(args.direction);
        if (
          e !== document.scrollingElement &&
          !/auto|scroll/.test(
            getComputedStyle(e)[horizontal ? "overflowX" : "overflowY"],
          )
        )
          return null;
        const before = horizontal ? e.scrollLeft : e.scrollTop;
        const amount =
          (horizontal ? e.clientWidth : e.clientHeight) *
          args.distance *
          (["left", "up"].includes(args.direction) ? -1 : 1);
        e.scrollTo({
          left: horizontal ? before + amount : e.scrollLeft,
          top: horizontal ? e.scrollTop : before + amount,
          behavior: "instant",
        });
        return { before, after: horizontal ? e.scrollLeft : e.scrollTop };
      },
      { direction, distance },
    );
    if (!value)
      throw new SafeError(
        "UNSUPPORTED_SCROLL",
        "Selected region is not scrollable",
      );
    return {
      movement: value.before === value.after ? "no_movement" : "moved",
    } as const;
  } finally {
    if (owned) await element.dispose();
  }
}
