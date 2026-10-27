import type { PluginModule } from "../../plugins/api";
import { registerAttention } from "../../features/agents/attention-command";
import { registerDiscovery } from "../../features/agents/attention-discovery";
import { AgentsPage } from "./AgentsPage";
import { availableAgentProviderRoute } from "./routes";

export const inject = ["pages", "agents", "relay", "navigation", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  registerAttention(ctx);
  registerDiscovery(ctx.agents);
  const { agents, relay, navigation: navigator } = ctx;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: availableAgentProviderRoute,
    },
    component: ({ navigation }) => (
      <AgentsPage
        agents={agents}
        relay={relay}
        navigator={navigator}
        {...(navigation ? { navigation } : {})}
      />
    ),
  });
};
