import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import { handoffBackupSession } from "../../features/identity/backup";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { Login } from "./login/Login";
import {
  browserCredential,
  browserLoginAvailable,
  oauthTarget,
} from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { builderlabType } from "./adapter-type";
import { builderlabProvider } from "./decisions";
import type { AgentProviderSnapshot } from "../../features/agents/service";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";

export const inject = ["host", "settingsCards", "agents", "relay", "decisions"];
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
  if (!unavailable) {
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
    ctx.decisions.registerProvider(builderlabProvider(session, loginAvailable));
    // PLAYPEN ONLY (do not merge): one Builderlab decision from the devtools
    // console, through the selected provider, with no agent or watch setup:
    // `await __playpenDecide()`.
    (globalThis as Record<string, unknown>).__playpenDecide = (
      community = "wss://buzz.block.builderlab.xyz",
    ) =>
      ctx.decisions.decide({
        state:
          "Alice: can someone review my PR before 5pm? It blocks the release.",
        questions: {
          urgent: {
            type: "yes_no",
            instructions: "Does this message ask for something time-sensitive?",
          },
          kind: {
            type: "choice",
            instructions: "What kind of message is this?",
            options: {
              request: "It asks someone to do something.",
              update: "It only shares information.",
            },
          },
          importance: {
            type: "score",
            instructions: "How important is this message to the team?",
            levels: ["low", "medium", "high"],
          },
        },
        community,
      });
  }
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
            browserLoginAvailable()
              ? unavailable
              : "Open the Buzz desktop app to sign in with Builderlab."
          }
          active={active}
        />
        <RemoteAgents client={agents} session={session} active={active} />
      </section>
    ),
  });
};
