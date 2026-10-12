import { communityDestination } from "../../features/communities/destination";
import type { PluginModule } from "../../plugins/api";
import { Login } from "./login/Login";
import {
  browserCredential,
  browserLoginAvailable,
  oauthTarget,
} from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { createEnrollment } from "./agents/enrollment";

export const inject = [
  "host",
  "settingsCards",
  "relay",
  "communityReader",
  "agents",
];
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
  if (!unavailable)
    ctx.agents.register({
      id: "builderlab",
      title: "Builderlab",
      description: "TBD",
      defaults: () => ({ config: {} }),
    });
  const session = createOAuthSession((signal) =>
    browserCredential(ctx.host, signal),
  );
  ctx.effect(() => () => session.dispose());
  const agents = createAgentClient(ctx.host, session, () => {
    const selected = ctx.communityReader.snapshot().selected;
    return selected
      ? communityDestination(selected).url.replace(/^https:/, "wss:")
      : undefined;
  });
  const enrollment = createEnrollment(ctx.relay, ctx.communityReader, session);
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    group: "Integrations",
    component: ({ active }) => (
      <>
        <Login
          session={session}
          available={browserLoginAvailable() && !unavailable}
          unavailableReason={
            browserLoginAvailable()
              ? unavailable
              : "Open the Buzz desktop app to sign in with Builderlab."
          }
          active={active}
        />
        <RemoteAgents
          client={agents}
          session={session}
          enrollment={enrollment}
          active={active}
        />
      </>
    ),
  });
};
