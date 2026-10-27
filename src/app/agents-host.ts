// FOUNDATION: Compose the page that runs agents apart from the screens: the
// plugins' agent entries and the agents service, served to the screens' page
// over the agents port. It shows nothing, and keeps nothing on the device
// for the screens: their communities, outbox and history stay theirs.
import { Context } from "@deepseek-ai/cordis";
import { bundledPlugins } from "../bundled";
import { AGENTS_WEBVIEW } from "../features/agents/apart";
import { eventPort } from "../features/agents/event-port";
import { createLocalAgents } from "../features/agents/local";
import { createLocalAgentActivity } from "../features/agents/local-activity";
import { type AgentsPort, serveAgents } from "../features/agents/port";
import { AgentsService } from "../features/agents/service";
import type { ToolOwner } from "../features/agents/tool-port";
import { pageCommunities } from "../features/communities/page";
import { DecisionsService } from "../features/decisions/service";
import { HostService } from "../features/host/service";
import { IdentityNamesService } from "../features/identity-names/service";
import { connectNativeTransport } from "../features/relay/native";
import { createPluginManager } from "../plugins/manager";
import { withTimeout } from "../plugins/timeout";

export function createAgentsHost(
  port: AgentsPort = eventPort(AGENTS_WEBVIEW, "main"),
) {
  const ctx = new Context();
  new HostService(ctx);
  const plugins = createPluginManager(ctx, {
    bundled: bundledPlugins,
    parts: "agent",
  });
  const localAgents = createLocalAgents();
  const localActivity = createLocalAgentActivity();
  const decisions = new DecisionsService(ctx);
  const identityNames = new IdentityNamesService(ctx, localAgents.agents);
  const communities = pageCommunities(ctx, connectNativeTransport, {
    identityNames,
    agentChoices: localAgents.agents,
    localAgents: localActivity.reader,
  });
  const agents = new AgentsService(
    ctx,
    communities,
    undefined,
    undefined,
    undefined,
    localActivity,
    undefined,
    decisions,
  );
  ctx.effect(() =>
    localAgents.bind({
      snapshot: agents.local,
      subscribe: agents.subscribe,
      refresh: () => agents.refresh(),
    }),
  );
  /** Runs `add` as `owner`'s, as the screens' page's plugin runtime names
   * it, until the returned stop. */
  const as = (owner: ToolOwner, add: (plugin: Context) => void) => {
    const fiber = ctx
      .extend({ pluginOwner: Object.freeze({ ...owner }) })
      .plugin({ inject: ["agents"], apply: add });
    return () => void fiber.dispose();
  };
  const stop = serveAgents(agents, port, {
    addTool: (tool, owner) =>
      as(owner, (plugin) => plugin.agents.addTool(tool)),
    register: (type, owner) =>
      as(owner, (plugin) => plugin.agents.register(type)),
    local: localAgents.agents,
    activity: localActivity.reader,
    follow: communities.follow,
  });
  let disposal: Promise<void> | undefined;
  return {
    agents,
    dispose() {
      stop();
      disposal ??= withTimeout(
        Promise.all([plugins.dispose(), ctx.fiber.dispose()]),
        "Agents cleanup timed out; restart the app",
      ).then(() => {});
      return disposal;
    },
  };
}
