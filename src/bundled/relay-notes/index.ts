import type { PluginModule } from "../../plugins/api";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { callNoteTool, NOTE_TOOLS as definitions } from "../../buzz-mcp/tools";

export const NOTE_TOOLS: readonly AddedTool[] = definitions.map((tool) => ({
  ...tool,
  call: (client, context, args) =>
    callNoteTool(client, context, tool.name, args),
}));
export const inject = ["agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  for (const tool of NOTE_TOOLS) ctx.agents.addTool(tool);
};
