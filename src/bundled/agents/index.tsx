import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { availableAgentProviderRoute } from "./routes";

export const inject = ["pages", "agents", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, relay, navigation: navigator } = ctx;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: availableAgentProviderRoute,
      // The provider dialog is presentation over this page, never a visit.
      overlay: ["provider"],
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
