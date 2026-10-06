import type { AgentTurn } from "../contracts/run.js";
import type { InternalMessage } from "../runtime/history.js";
import type { toolDefinitions } from "../contracts/tools.js";
export interface ModelClient {
  readonly model: string;
  complete(
    messages: InternalMessage[],
    tools: typeof toolDefinitions,
    options?: { signal?: AbortSignal },
  ): Promise<AgentTurn>;
}
