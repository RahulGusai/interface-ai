import type { StartCommand } from "../bridge/protocol.js";
import type { DiscoveryProposal } from "../contracts/discovery-proposal.js";
import type { Capture } from "../contracts/observation.js";
import type { DurableTarget } from "../contracts/artifact.js";
export type RecordedAction = {
  call_id: string;
  tool: string;
  input: any;
  target?: DurableTarget;
  result: any;
};
export type DiscoveryContext = {
  deployment: StartCommand["deployment"];
  capability_catalog: any[];
  inputs: Record<string, unknown>;
  records: RecordedAction[];
  references: DiscoveryProposal["reference_assets"];
  recordReference?: (
    record: any,
    crop: Buffer,
    capture: Capture,
    callId: string,
  ) => Promise<void>;
  artifact?: DiscoveryProposal;
};
