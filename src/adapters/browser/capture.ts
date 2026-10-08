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
        text: e.label,
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
      tr: "row",
      td: "cell",
      th: "columnheader",
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
    let tableCell: Control["table_cell"];
    if (e instanceof HTMLTableCellElement && tag === "td") {
      const table = e.closest("table");
      const row = e.parentElement;
      if (table && row instanceof HTMLTableRowElement) {
        const header = Array.from(table.rows).find((r) =>
          Array.from(r.cells).some((c) => c.tagName === "TH"),
        );
        const rows = Array.from(table.rows).filter((r) => {
          const bounds = r.getBoundingClientRect();
          const style = getComputedStyle(r);
          return (
            Array.from(r.cells).some((c) => c.tagName === "TD") &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            !r.closest('[aria-hidden="true"]')
          );
        });
        if (
          header &&
          rows.indexOf(row) >= 0 &&
          Array.from(header.cells).every((c) => c.colSpan === 1) &&
          Array.from(row.cells).every((c) => c.colSpan === 1 && c.rowSpan === 1)
        )
          tableCell = {
            columns: Array.from(header.cells).map((c) =>
              (c.innerText || c.textContent || "")
                .replace(/[▲▼△▽↑↓]/g, "")
                .trim(),
            ),
            column_index: e.cellIndex,
            row_index: rows.indexOf(row),
          };
      }
    }
    const ancestry: { role: string; name: string; exact: true }[] = [];
    for (let p = e.parentElement; p; p = p.parentElement) {
      const role =
        p.getAttribute("role") ??
        (
          {
            form: "form",
            fieldset: "group",
            nav: "navigation",
            section: "region",
            table: "table",
          } as Record<string, string>
        )[p.tagName.toLowerCase()];
      const name =
        p.getAttribute("aria-label") ??
        p
          .getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map((id) => p!.ownerDocument.getElementById(id)?.textContent ?? "")
          .join(" ") ??
        "";
      if (role && name)
        ancestry.unshift({ role, name: name.trim(), exact: true });
    }
    return {
      role,
      name,
      state,
      ...(tableCell ? { table_cell: tableCell } : {}),
      text: (e as HTMLElement).innerText?.replace(/\r\n?/g, "\n"),
      ancestry,
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
  const handles = new Set<Element>();
  try {
    for (const frame of page.frames()) {
      const elements = (await frame.$$("body *")) as Element[];
      const rowRefs = new Map<string, string>();
      for (const element of elements) handles.add(element);
      for (const element of elements) {
        const semantics = await readSemantics(element);
        if (!semantics) {
          await element.dispose();
          handles.delete(element);
          continue;
        }
        const ref = `c${controls.length + 1}`;
        const control: Control = {
          ref,
          ...semantics,
          ancestry: [
            { role: "document", name: frame.name(), exact: true },
            ...(semantics.ancestry ?? []),
          ],
          frame: {
            name: frame.name(),
            url_path: new URL(
              frame.url() === "about:blank" ? "http://blank/" : frame.url(),
            ).pathname,
          },
        };
        if (control.role === "option") {
          const select = await element.evaluateHandle((e) =>
            e.closest("select"),
          );
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
        if (control.role !== "option") {
          const rowPath = await element.evaluate((e) => {
            const row = e.closest('tr,[role="row"]');
            if (!row) return null;
            const indices: number[] = [];
            for (
              let node: HTMLElement | null = row as HTMLElement;
              node && node !== e.ownerDocument.body;
              node = node.parentElement
            ) {
              if (!node.parentElement) return null;
              indices.push(
                Array.prototype.indexOf.call(node.parentElement.children, node),
              );
            }
            return indices.reverse().join(".");
          });
          if (rowPath !== null) {
            if (control.role === "row") rowRefs.set(rowPath, ref);
            else control.parent_ref = rowRefs.get(rowPath);
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
  } catch (error) {
    // A document replacement can interrupt collection before bindings are returned.
    // Release every handle from the incomplete attempt before the capture retries.
    await Promise.all(
      [...handles].map((element) => element.dispose().catch(() => {})),
    );
    throw error;
  }
}
