import type {
  Classification,
  PolicyViolation,
} from "../runtime/action-policy.js";
import type { BrowserAction, ToolResponse } from "../contracts/tools.js";
import type { Capture } from "../contracts/observation.js";
import type { TaskInput } from "../contracts/run.js";
export interface BrowserAdapterPort {
  readonly kind: "browser";
  readonly capabilities: ReadonlySet<string>;
  classifyAction?(action: BrowserAction): Promise<Classification>;
  readonly policySignal?: AbortSignal;
  policyViolation?(): PolicyViolation | undefined;
  execute(action: BrowserAction): Promise<ToolResponse>;
  capture(
    mode: "screenshot" | "controls" | "both",
    options?: { includeAriaHidden?: boolean },
  ): Promise<Capture>;
  isCurrentObservation(id: string): boolean;
  close(): Promise<void>;
}
export interface BrowserAdapterFactory {
  createForTask(input: TaskInput): Promise<BrowserAdapterPort>;
}
