import type { AgentTurn } from "../contracts/run.js";
import type { InternalMessage } from "../runtime/history.js";
import type { toolDefinitions } from "../contracts/tools.js";
import type { CapabilityMetadata } from "../runtime/capability-metadata.js";
export interface ModelClient {
  readonly model: string;
  generateCapability?(
    goal: string,
    suppliedInputs: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<CapabilityMetadata>;
  complete(
    messages: InternalMessage[],
    tools: typeof toolDefinitions,
    options?: { signal?: AbortSignal; toolChoice?: string },
  ): Promise<AgentTurn>;
}
