import type { Page } from "playwright";
import { SafeError } from "../../contracts/errors.js";
import type { Resolved, Element } from "./targets.js";
export async function click(page: Page, target: Resolved, timeout: number) {
  if (target.kind === "control")
    await target.binding.element.click({ timeout });
  else {
    const hit = await page.evaluate(({ x, y }) => {
      const e = document.elementFromPoint(x, y);
      return !!e && getComputedStyle(e).pointerEvents !== "none";
    }, target);
    if (!hit)
      throw new SafeError("POINT_BLOCKED", "No receiving surface at point");
    await page.mouse.click(target.x, target.y);
  }
}
async function editable(element: Element) {
  return element.evaluate((e) => {
    const x = e as HTMLInputElement;
    return (
      e.isConnected &&
      !x.disabled &&
      !x.readOnly &&
      (e instanceof HTMLTextAreaElement ||
        (e instanceof HTMLInputElement &&
          [
            "text",
            "search",
            "email",
            "url",
            "tel",
            "password",
            "number",
            "",
          ].includes(e.type)) ||
        (e as HTMLElement).isContentEditable)
    );
  });
}
export async function readValue(element: Element) {
  return element.evaluate((e) =>
    "value" in e
      ? String((e as HTMLInputElement).value)
      : (e as HTMLElement).isContentEditable
        ? (e as HTMLElement).innerText
        : null,
  );
}
export async function typeText(
  page: Page,
  target: Resolved,
  text: string,
  mode: "replace" | "append",
  timeout: number,
) {
  let element: Element;
  let owned = false;
  if (target.kind === "control") {
    element = target.binding.element;
    if (!(await editable(element)))
      throw new SafeError("NOT_EDITABLE", "Target is not editable");
    await element.focus();
  } else {
    await click(page, target, timeout);
    const focus = await page.evaluateHandle(
      ({ x, y }) => {
        let doc = document;
        let hit: globalThis.Element | null = doc.elementFromPoint(x, y);
        while (hit instanceof HTMLIFrameElement) {
          const rect = hit.getBoundingClientRect();
          if (!hit.contentDocument) return null; // Cross-origin focus correspondence is unsupported.
          x -= rect.left + hit.clientLeft;
          y -= rect.top + hit.clientTop;
          doc = hit.contentDocument;
          hit = doc.elementFromPoint(x, y);
        }
        const active = doc.activeElement;
        // A click may be cancelled while retaining another field's focus. Never type there.
        if (!active || !hit || !(hit === active || active.contains(hit)))
          return null;
        return active;
      },
      { x: target.x, y: target.y },
    );
    const candidate = focus.asElement();
    if (!candidate) {
      await focus.dispose();
      throw new SafeError(
        "NOT_EDITABLE",
        "Point did not establish editable focus",
      );
    }
    element = candidate as Element;
    owned = true;
  }
  try {
    if (
      !(await editable(element)) ||
      !(await element.evaluate((e) => e.ownerDocument.activeElement === e))
    )
      throw new SafeError("NOT_EDITABLE", "Editable focus was not established");
    const before = await readValue(element);
    const expected =
      mode === "replace" ? text : before === null ? null : before + text;
    if (mode === "replace") await element.fill(text, { timeout });
    else {
      await element.press("ControlOrMeta+End", { timeout });
      await page.keyboard.insertText(text);
    }
    const after = await readValue(element);
    return {
      verification:
        expected === null || after === null
          ? "unavailable"
          : after === expected
            ? "matched"
            : "mismatched",
    } as const;
  } finally {
    if (owned) await element.dispose();
  }
}
export async function pressKey(
  page: Page,
  target: Resolved | undefined,
  keys: string[],
) {
  if (target) {
    if (target.kind !== "control")
      throw new SafeError("UNSUPPORTED", "Control required");
    await target.binding.element.focus();
    if (
      !(await target.binding.element.evaluate(
        (e) => e.ownerDocument.activeElement === e,
      ))
    )
      throw new SafeError("FOCUS_FAILED", "Target cannot receive focus");
  }
  const modifiers = keys.slice(0, -1);
  try {
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    await page.keyboard.press(keys.at(-1)!);
  } finally {
    for (const modifier of modifiers.reverse())
      await page.keyboard.up(modifier).catch(() => {});
  }
}
export async function selectOption(
  target: Resolved,
  label: string,
  timeout: number,
) {
  if (target.kind !== "control")
    throw new SafeError("UNSUPPORTED", "Control required");
  const { element, options } = target.binding;
  if (!options || !options.includes(label))
    throw new SafeError("UNOBSERVED_OPTION", "Option was not observed");
  const valid = await element.evaluate((e, label) => {
    if (!(e instanceof HTMLSelectElement) || e.multiple) return false;
    const matches = Array.from(e.options).filter((o) => o.label === label);
    return (
      !e.disabled &&
      matches.length === 1 &&
      !matches[0]!.disabled &&
      !(
        matches[0]!.parentElement instanceof HTMLOptGroupElement &&
        matches[0]!.parentElement.disabled
      )
    );
  }, label);
  if (!valid)
    throw new SafeError(
      "UNSUPPORTED_SELECTION",
      "Selection is unsupported, missing, ambiguous or disabled",
    );
  await element.selectOption({ label }, { timeout });
  const selected = await element.evaluate(
    (e) => (e as HTMLSelectElement).selectedOptions[0]?.label,
  );
  return {
    verification: selected === label ? "matched" : "mismatched",
    selected_label: selected,
  } as const;
}
