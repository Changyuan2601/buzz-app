import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import { createFederatedSession } from "../../features/federated-identity/session";
import { Login } from "./login/Login";
import { createBuilderlabSession } from "./session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { builderlabType } from "./adapter-type";
import type { AgentProviderSnapshot } from "../../features/agents/service";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";

export const inject = ["federatedIdentity", "settingsCards", "agents", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const session = createBuilderlabSession(
    createFederatedSession(ctx.federatedIdentity),
  );
  ctx.effect(() => () => session.dispose());
  const agents = createAgentClient(session);
  const unavailable = ctx.federatedIdentity.apiAvailable
    ? ""
    : "Open the Buzz desktop app to sign in with Builderlab.";
  const loginAvailable = !unavailable;
  // Native discovery can finish after apply. Register once the authority is
  // known; the registration is owned by ctx, so disposal removes it.
  let registered = false;
  const registerType = () => {
    if (registered || !session.available()) return;
    registered = true;
    let providerState: AgentProviderSnapshot = {
      readiness: "attention",
      attentionLabel: "Log in to Builderlab",
    };
    const providerListeners = new Set<() => void>();
    const updateProvider = () => {
      const state = session.snapshot();
      providerState = Object.freeze(
        state.status === "signed-in"
          ? state.account?.canUseRemoteAgents
            ? { readiness: "ready" }
            : { readiness: "attention", attentionLabel: "Coming soon" }
          : state.status === "pending"
            ? { readiness: "checking", blocking: true }
            : {
                readiness: "attention",
                attentionLabel: "Log in to Builderlab",
              },
      );
      for (const listener of providerListeners) listener();
    };
    const stopProvider = session.subscribe(updateProvider);
    const ProviderDialogBody = () => {
      const state = useSyncExternalStore(session.subscribe, session.snapshot);
      return (
        <div className="grid gap-3">
          <InlineHeader level={3} title="Connection" />
          <Login
            session={session}
            available={loginAvailable}
            active={() => true}
            showHeading={false}
          />
          {state.status === "signed-in" &&
            !state.account?.canUseRemoteAgents && (
              <p role="status" className="text-body-sm text-secondary">
                Builderlab remote agents are coming soon for your account.
              </p>
            )}
        </div>
      );
    };
    ctx.agents.register({
      ...builderlabType(agents, session, ctx.relay),
      provider: {
        snapshot: () => providerState,
        subscribe: (listener) => {
          providerListeners.add(listener);
          return () => providerListeners.delete(listener);
        },
        check: updateProvider,
        DialogBody: ProviderDialogBody,
      },
    });
    ctx.effect(() => () => stopProvider());
  };
  registerType();
  ctx.effect(() => ctx.federatedIdentity.subscribe(registerType));
  // Link the Buzz key at sign-in. Best effort: activation links again and
  // reports why when it cannot.
  let linked: unknown;
  ctx.effect(() =>
    session.subscribe(() => {
      if (session.snapshot().status !== "signed-in") return;
      const credential = session.credential();
      if (linked === credential) return;
      linked = credential;
      void agents.link(new AbortController().signal).catch(() => {});
    }),
  );
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab agents",
    group: "Plugins",
    component: ({ active }) => (
      <section aria-labelledby="builderlab-agents-title">
        <Header id="builderlab-agents-title" title="Builderlab agents" />
        <Login
          showHeading={false}
          session={session}
          available={loginAvailable}
          unavailableReason={
            unavailable ||
            "Builderlab sign-in is not configured for this Buzz build."
          }
          active={active}
        />
        <RemoteAgents client={agents} session={session} active={active} />
      </section>
    ),
  });
};
