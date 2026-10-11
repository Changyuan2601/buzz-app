import { useSyncExternalStore } from "react";
import { Login } from "../../features/federated-identity/Login";
import { createFederatedSession } from "../../features/federated-identity/session";
import type { PluginModule } from "../../plugins/api";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { HostedCommunities } from "./HostedCommunities";
import { brokerApi, createApi } from "./api";
import { createNativeBackend } from "./native";
import { GlobeIcon } from "../../shared/design-system/icons";

export const inject = ["host", "federatedIdentity", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Same split as HostService: live development keeps the broker; desktop builds go native.
  let api = brokerApi;
  if (nativeIdentityEnabled()) {
    const native = createNativeBackend(ctx.federatedIdentity);
    api = createApi(native.backend);
  }
  const session = createFederatedSession(ctx.federatedIdentity);
  function NativeCard({ active }: { active: () => boolean }) {
    const state = useSyncExternalStore(
      session.subscribe,
      session.snapshot,
      session.snapshot,
    );
    return (
      <>
        <Login
          title="Federated identity"
          unavailableReason="Federated sign-in is not configured for this Buzz build."
          session={session}
          available
          active={active}
        />
        {ctx.federatedIdentity.apiAvailable ? (
          <HostedCommunities
            key={state.account?.revision}
            api={api}
            active={active}
          />
        ) : (
          <p role="status" className="text-body-sm text-secondary">
            Hosted community management is unavailable until the identity API
            contract is enabled.
          </p>
        )}
      </>
    );
  }
  ctx.settingsCards.register({
    id: "hosted",
    title: "Builderlab hosting",
    icon: GlobeIcon,
    group: "Plugins",
    component: ({ active }) =>
      nativeIdentityEnabled() ? (
        <NativeCard active={active} />
      ) : (
        <HostedCommunities api={api} active={active} />
      ),
  });
};
