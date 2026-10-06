import {
  toolDefinitions,
  parseToolAction,
  type BrowserAction,
} from "../contracts/tools.js";
import type { BrowserAdapterPort } from "../adapters/surface.js";
export { toolDefinitions };
export const ToolRegistry = {
  definition: (name: string) =>
    toolDefinitions.find((d) => d.function.name === name),
  parse: parseToolAction,
};
export const executeTool = (
  adapter: BrowserAdapterPort,
  action: BrowserAction,
) => adapter.execute(action);
