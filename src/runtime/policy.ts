import type { ToolAction, ToolName, ToolResponse } from "../contracts/tools.js";
import { dispatchErrorSchema, toolResultSchemas } from "../contracts/tools.js";
import type { DialogEvent } from "../contracts/errors.js";
export type Decision = "allow" | "deny" | "intervention";
export type PolicyConfig = {
  documents: { origin: string; pathPrefix: string }[];
  resourceOrigins: string[];
  allowedActions: ToolName[];
  allowScreenshots: boolean;
  allowSrcdocFrames?: boolean;
  redactPatterns?: string[];
  riskyAction: (action: ToolAction) => Decision;
  dialogs?: {
    type: string;
    message: string;
    decision: "accept" | "dismiss";
    promptText?: string;
  }[];
  businessCodes?: string[];
  validateOutputs?: (outputs: Record<string, unknown>) => boolean;
  allowField?: (name: string, value: string | number) => boolean;
};
export class RuntimePolicy {
  constructor(readonly config: PolicyConfig) {
    for (const d of config.documents) {
      const u = new URL(d.origin);
      if (
        u.origin !== d.origin ||
        !["http:", "https:"].includes(u.protocol) ||
        !d.pathPrefix.startsWith("/")
      )
        throw new Error("Invalid trusted URL policy");
    }
  }
  allowUrl(raw: string, resource = false) {
    try {
      const u = new URL(raw);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        return false;
      if (resource) return this.config.resourceOrigins.includes(u.origin);
      const decoded = decodeURIComponent(u.pathname);
      if (/%|\\|\/\.\.?\//.test(decoded) || /%2f|%5c/i.test(u.pathname))
        return false;
      return this.config.documents.some(
        (d) =>
          u.origin === d.origin &&
          (d.pathPrefix === "/" ||
            u.pathname === d.pathPrefix ||
            u.pathname.startsWith(d.pathPrefix.replace(/\/$/, "") + "/")),
      );
    } catch {
      return false;
    }
  }
  decide(action: ToolAction): Decision {
    if (!this.config.allowedActions.includes(action.name)) return "deny";
    if (action.name === "navigate" && !this.allowUrl(action.input.url))
      return "deny";
    if (
      ["click", "type_text", "press_key", "select_option", "navigate"].includes(
        action.name,
      )
    )
      return this.config.riskyAction(action);
    return "allow";
  }
  dialog(
    type: string,
    message: string,
  ): { decision: DialogEvent["decision"]; promptText?: string } {
    const match = this.config.dialogs?.find(
      (r) => r.type === type && r.message === message,
    );
    return match
      ? { decision: match.decision, promptText: match.promptText }
      : { decision: "intervention" };
  }
  text(value: string) {
    for (const pattern of this.config.redactPatterns ?? [])
      if (pattern) value = value.split(pattern).join("[REDACTED]");
    return value;
  }
  sanitize<T>(value: T): T {
    const walk = (v: unknown): unknown =>
      typeof v === "string"
        ? this.text(v)
        : Array.isArray(v)
          ? v.map(walk)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [this.text(k), walk(x)]),
              )
            : v;
    return walk(value) as T;
  }
  get permitImages() {
    return this.config.allowScreenshots && !this.config.redactPatterns?.length;
  }
  project(name: ToolName, response: ToolResponse): ToolResponse {
    const result = dispatchErrorSchema.safeParse(response.result).success
      ? dispatchErrorSchema.parse(response.result)
      : toolResultSchemas[name].parse(response.result);
    const safe = this.sanitize(result);
    const obs =
      "observation" in safe
        ? safe.observation
        : safe.status === "ok"
          ? safe
          : undefined;
    if (obs?.status === "ok" && obs.screenshot.status === "available") {
      if (!this.permitImages) {
        obs.screenshot = { status: "unavailable" };
        return { result: safe };
      }
      if (
        !response.image?.bytes.length ||
        response.image.ref !== obs.screenshot.image_ref
      )
        throw new Error("Missing image bytes");
      return { result: safe, image: response.image };
    }
    return { result: safe };
  }
}
export function syntheticPolicy(url: string) {
  const origin = new URL(url).origin;
  return new RuntimePolicy({
    documents: [{ origin, pathPrefix: "/" }],
    resourceOrigins: [origin],
    allowedActions: Object.keys(toolResultSchemas) as ToolName[],
    allowScreenshots: true,
    riskyAction: () => "allow",
    dialogs: [
      { type: "alert", message: "Synthetic notice", decision: "accept" },
      { type: "beforeunload", message: "", decision: "dismiss" },
    ],
    businessCodes: ["not_found"],
    validateOutputs: (outputs) =>
      Object.keys(outputs).every(
        (k) => k === "member" && typeof outputs[k] === "string",
      ),
  });
}
