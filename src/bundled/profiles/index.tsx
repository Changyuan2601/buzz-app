import type { PluginModule } from "../../plugins/api";
import { profilePanelKey } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";

export const inject = ["panels", "relay", "navigation", "agents2"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "profile",
    title: "Profile",
    matches: (target) => !!profilePanelKey(target),
    component: (props) => (
      <ProfilePanel
        {...props}
        relay={ctx.relay}
        navigation={ctx.navigation}
        agents2={ctx.agents2}
      />
    ),
  });
};
