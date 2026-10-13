import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";
import { availableAgentProviderRoute } from "./routes";
import { ClassifierSettings } from "./ClassifierSettings";

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
    group: "Integrations",
    component: ({ active }) => (
      <ClassifierSettings agents={agents} active={active} />
    ),
  });
};
