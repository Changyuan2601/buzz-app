import { useSyncExternalStore } from "react";
import { createFederatedSession } from "../../features/federated-identity/session";
import type { PluginModule } from "../../plugins/api";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { HostedCommunities } from "./HostedCommunities";
import { brokerApi, createApi } from "./api";
import { createNativeBackend } from "./native";
import { GlobeIcon } from "../../shared/design-system/icons";

export const inject = ["federatedIdentity", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Same split as HostService: live development keeps the broker; desktop builds go native.
  if (!nativeIdentityEnabled()) {
    ctx.settingsCards.register({
      id: "hosted",
      title: "Builderlab hosting",
      icon: GlobeIcon,
      group: "Plugins",
      component: ({ active }) => (
        <HostedCommunities api={brokerApi} active={active} />
      ),
    });
    return;
  }
  const api = createApi(createNativeBackend(ctx.federatedIdentity).backend);
  const session = createFederatedSession(ctx.federatedIdentity);
  ctx.settingsCards.register({
    id: "hosted",
    title: "Builderlab hosting",
    icon: GlobeIcon,
    group: "Plugins",
    component: function NativeHosted({ active }) {
      const state = useSyncExternalStore(
        session.subscribe,
        session.snapshot,
        session.snapshot,
      );
      // A new sign-in, sign-out or account change elsewhere starts the card over.
      return (
        <HostedCommunities
          key={state.account?.revision ?? state.status}
          api={api}
          active={active}
        />
      );
    },
  });
};
