import type { Control } from "../contracts/observation.js";
/** A value must be addressable independently of its current rendered contents. */
export function isReusableExtractionSource(control: Control): boolean {
  if (control.role === "cell" && control.table_cell) return true;
  if (!control.name.trim() || ["link", "button"].includes(control.role))
    return false;
  if (
    ["textbox", "combobox", "spinbutton", "checkbox", "radio"].includes(
      control.role,
    )
  )
    return true;
  return (
    control.text !== undefined && control.text.trim() !== control.name.trim()
  );
}
