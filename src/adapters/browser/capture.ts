import type { Page } from "playwright";
import type { Binding, Element } from "./targets.js";
import type { Control } from "../../contracts/observation.js";
export async function readSemantics(
  element: Element,
): Promise<Omit<Control, "ref"> | null> {
  return element.evaluate((e) => {
    // Native option labels are rendered by the browser's select UI, even when its popup is closed.
    if (e instanceof HTMLOptionElement) {
      const select = e.closest("select");
      if (!select) return null;
      const rect = select.getBoundingClientRect();
      const style = getComputedStyle(select);
      if (
        !rect.width ||
        !rect.height ||
        style.display === "none" ||
        style.visibility === "hidden"
      )
        return null;
      return {
        role: "option",
        name: e.label,
        state: {
          enabled:
            !select.disabled &&
            !e.disabled &&
            !(
              e.parentElement instanceof HTMLOptGroupElement &&
              e.parentElement.disabled
            ),
        },
      };
    }
    const r = e.getBoundingClientRect();
    const style = getComputedStyle(e);
    if (
      !e.isConnected ||
      r.width === 0 ||
      r.height === 0 ||
      style.visibility === "hidden" ||
      style.display === "none" ||
      e.closest('[aria-hidden="true"]')
    )
      return null;
    const tag = e.tagName.toLowerCase();
    const input = e as HTMLInputElement;
    const implicit: Record<string, string> = {
      button: "button",
      input:
        input.type === "checkbox"
          ? "checkbox"
          : input.type === "radio"
            ? "radio"
            : "textbox",
      textarea: "textbox",
      select: "combobox",
      a: "link",
      p: "text",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      label: "text",
      option: "option",
    };
    const role =
      e.getAttribute("role") ??
      implicit[tag] ??
      (e.children.length === 0 && e.textContent?.trim() ? "text" : "");
    if (!role) return null;
    const labelled = e
      .getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .map((id) => e.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    const labels =
      "labels" in e
        ? Array.from((e as HTMLInputElement).labels ?? [])
            .map((l) =>
              Array.from(l.childNodes)
                .filter((n) => n.nodeType === Node.TEXT_NODE)
                .map((n) => n.textContent)
                .join(""),
            )
            .join(" ")
        : "";
    const name = (
      e.getAttribute("aria-label") ||
      labelled ||
      labels ||
      e.getAttribute("alt") ||
      e.getAttribute("title") ||
      (e as HTMLElement).innerText ||
      e.textContent ||
      ""
    ).trim();
    const state: Control["state"] = {
      enabled:
        !e.matches(":disabled") && e.getAttribute("aria-disabled") !== "true",
      focused: e.ownerDocument.activeElement === e,
    };
    if (input.type === "checkbox" || input.type === "radio")
      state.checked = input.checked;
    if (e.hasAttribute("aria-expanded"))
      state.expanded = e.getAttribute("aria-expanded") === "true";
    return {
      role,
      name,
      state,
      ...("value" in e && input.type !== "password"
        ? { value: String(input.value) }
        : {}),
    };
  });
}
export async function collectControls(page: Page): Promise<{
  controls: Control[];
  bindings: Map<string, Binding>;
  links: string[];
}> {
  const controls: Control[] = [];
  const bindings = new Map<string, Binding>();
  const links: string[] = [];
  for (const frame of page.frames()) {
    const elements = (await frame.$$("body *")) as Element[];
    for (const element of elements) {
      const semantics = await readSemantics(element);
      if (!semantics) {
        await element.dispose();
        continue;
      }
      const ref = `c${controls.length + 1}`;
      const control: Control = { ref, ...semantics };
      if (control.role === "option") {
        const select = await element.evaluateHandle((e) => e.closest("select"));
        try {
          for (const binding of bindings.values())
            if (
              binding.control.role === "combobox" &&
              (await binding.element.evaluate(
                (node, parent) => node === parent,
                select,
              ))
            ) {
              control.parent_ref = binding.control.ref;
              break;
            }
        } finally {
          await select.dispose();
        }
      }
      const options = await element.evaluate((e) =>
        e instanceof HTMLSelectElement
          ? Array.from(e.options).map((o) => o.label)
          : undefined,
      );
      bindings.set(ref, { element, control, options });
      controls.push(control);
      const href = await element.evaluate((e) =>
        e instanceof HTMLAnchorElement ? e.href : null,
      );
      if (href) links.push(href);
    }
  }
  return { controls, bindings, links };
}
