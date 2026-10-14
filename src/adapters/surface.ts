import type {
  Classification,
  PolicyViolation,
} from "../runtime/action-policy.js";
import type { BrowserAction, ToolResponse } from "../contracts/tools.js";
import type { Capture, Target } from "../contracts/observation.js";
import type { TaskInput } from "../contracts/run.js";
import type { ToolAction } from "../contracts/tools.js";
import type { ReviewSnapshot, TargetBounds } from "../runtime/human-review.js";
export interface BrowserAdapterPort {
  reviewSnapshot?(action: ToolAction): Promise<ReviewSnapshot>;
  targetBounds?(target: Target): Promise<TargetBounds | null>;
  readonly reviewSignal?: AbortSignal;
  authorizeReadWrite?(action: BrowserAction): void;
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
