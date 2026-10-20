import type { PluginModule } from "../../plugins/api";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { HostedCommunities } from "./HostedCommunities";
import { brokerApi, createApi } from "./api";
import { createNativeBackend } from "./native";
import { GlobeIcon } from "../../shared/design-system/icons";

export const inject = ["host", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Same split as HostService: live development keeps the broker; desktop builds go native.
  let api = brokerApi;
  if (nativeIdentityEnabled()) {
    const native = createNativeBackend(ctx.host);
    ctx.effect(() => native.dispose);
    api = createApi(native.backend);
  }
  ctx.settingsCards.register({
    id: "hosted",
    title: "Builderlab hosting",
    icon: GlobeIcon,
    group: "Plugins",
    component: ({ active }) => <HostedCommunities api={api} active={active} />,
  });
};
