import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { availableAgentProviderRoute } from "./routes";
import { ClassifierSettings } from "./ClassifierSettings";
import { CONFIG_SYNC_ENABLED } from "../../features/agents/community-config";
import { DeletedAgentsSettings } from "./DeletedAgentsSettings";

export const inject = [
  "pages",
  "agents",
  "relay",
  "navigation",
  "settingsCards",
];
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
  ctx.settingsCards.register({
    id: "jev-classifier",
    title: "Jev classifier",
    group: "Plugins",
    component: ({ active }) => (
      <ClassifierSettings agents={agents} active={active} />
    ),
  });
  // Deleting is an archive only with config sync; until then it hard-deletes.
  if (CONFIG_SYNC_ENABLED)
    ctx.settingsCards.register({
      id: "deleted-agents",
      title: "Deleted agents",
      group: "Account",
      component: ({ active }) => (
        <DeletedAgentsSettings agents={agents} active={active} />
      ),
    });
};
