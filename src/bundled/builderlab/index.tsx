import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import { Login as FederatedLogin } from "../../features/federated-identity/Login";
import { createFederatedSession } from "../../features/federated-identity/session";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { handoffBackupSession } from "../../features/identity/backup";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { Login as LegacyLogin } from "./login/Login";
import {
  browserCredential,
  browserLoginAvailable,
  oauthTarget,
} from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { builderlabType } from "./adapter-type";
import type { AgentProviderSnapshot } from "../../features/agents/service";
import { InlineHeader } from "../../shared/design-system/ui/Header";

export const inject = ["host", "federatedIdentity", "settingsCards", "agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  let unavailable = "";
  try {
    oauthTarget();
  } catch (error) {
    unavailable =
      error instanceof Error
        ? error.message
        : "Builderlab sign-in is unavailable.";
  }
  const session = createOAuthSession((signal) => {
    if (!browserLoginAvailable())
      throw new Error("Open the Buzz desktop app to sign in with Builderlab.");
    return browserCredential(ctx.host, signal);
  });
  const federatedSession = createFederatedSession(ctx.federatedIdentity);
  ctx.effect(() => () => session.dispose());
  const backupSession = () => {
    if (!nativeIdentityEnabled()) return;
    handoffBackupSession(
      "builderlab",
      session.snapshot().status === "signed-in"
        ? session.credential().value
        : null,
    );
  };
  ctx.effect(() => {
    const stop = session.subscribe(backupSession);
    return () => {
      stop();
      if (nativeIdentityEnabled()) handoffBackupSession("builderlab", null);
    };
  });
  const agents = createAgentClient(ctx.host, session);
  const loginAvailable = browserLoginAvailable() && !unavailable;
  let providerState: AgentProviderSnapshot = {
    readiness: "attention",
    attentionLabel: "Log in to Builderlab",
  };
  const providerListeners = new Set<() => void>();
  const updateProvider = () => {
    const state = session.snapshot();
    providerState = Object.freeze(
      state.status === "signed-in"
        ? { readiness: "ready" }
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
  ctx.effect(() => () => stopProvider());
  const ProviderDialogBody = () => (
    <div className="grid gap-3">
      <InlineHeader level={3} title="Connection" />
      <LegacyLogin
        session={session}
        available={loginAvailable}
        active={() => true}
        showHeading={false}
      />
    </div>
  );

  // A configured or still-restoring FI session must never expose the legacy
  // OAuth provider. The descriptor is fixed at build time, so absence is final.
  let providerRegistered = false;
  ctx.effect(() => {
    let active = true;
    const registerLegacyProvider = () => {
      if (
        !active ||
        providerRegistered ||
        unavailable ||
        ctx.federatedIdentity.snapshot().status !== "unconfigured"
      )
        return;
      providerRegistered = true;
      ctx.agents.register({
        ...builderlabType(agents, session),
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
    };
    const stop = ctx.federatedIdentity.subscribe(registerLegacyProvider);
    registerLegacyProvider();
    return () => {
      active = false;
      stop();
    };
  });

  // Link the Buzz key only for the legacy Builderlab account flow. In FI mode
  // the shared native owner supplies the session and protected requests.
  let linked: unknown;
  ctx.effect(() =>
    session.subscribe(() => {
      if (
        ctx.federatedIdentity.snapshot().status !== "unconfigured" ||
        session.snapshot().status !== "signed-in"
      )
        return;
      const credential = session.credential();
      if (linked === credential) return;
      linked = credential;
      void agents.link(new AbortController().signal).catch(() => {});
    }),
  );

  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    group: "Integrations",
    component: ({ active }) => (
      <BuilderlabSettings
        identity={ctx.federatedIdentity}
        federatedSession={federatedSession}
        legacySession={session}
        legacyAgents={agents}
        legacyUnavailable={unavailable}
        loginAvailable={loginAvailable}
        active={active}
      />
    ),
  });
};

function BuilderlabSettings({
  identity,
  federatedSession,
  legacySession,
  legacyAgents,
  legacyUnavailable,
  loginAvailable,
  active,
}: {
  identity: FederatedIdentity;
  federatedSession: ReturnType<typeof createFederatedSession>;
  legacySession: ReturnType<typeof createOAuthSession>;
  legacyAgents: ReturnType<typeof createAgentClient>;
  legacyUnavailable: string;
  loginAvailable: boolean;
  active(): boolean;
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  if (state.status === "unconfigured")
    return (
      <>
        <LegacyLogin
          session={legacySession}
          available={loginAvailable}
          unavailableReason={
            browserLoginAvailable()
              ? legacyUnavailable
              : "Open the Buzz desktop app to sign in with Builderlab."
          }
          active={active}
        />
        <RemoteAgents
          client={legacyAgents}
          session={legacySession}
          active={active}
        />
      </>
    );
  if (state.status === "restoring")
    return (
      <p role="status" className="text-body-sm text-secondary">
        Checking the Builderlab session…
      </p>
    );
  return (
    <>
      <FederatedLogin
        session={federatedSession}
        available={!!state.authority}
        unavailableReason="Federated sign-in is unavailable for this Buzz build."
        active={active}
      />
      <p role="status" className="text-body-sm text-secondary">
        Remote agent management is unavailable until the identity API contract
        is enabled.
      </p>
    </>
  );
}
