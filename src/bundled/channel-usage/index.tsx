import type { PluginModule } from "../../plugins/api";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";
import { ChannelUsage } from "./ChannelUsage";

export function eligible(channel: ChannelSummary, session: RelaySession) {
  return (
    !!session.agentActivity?.archive &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived &&
    !!channel.members?.includes(session.viewer ?? "")
  );
}

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.panels.register({
    id: "usage",
    title: "Usage",
    matches: () => false,
    channelMenu: { label: "View channel usage", eligible },
    component: ({ channelContext }) => {
      const connection = useRelayConnection(relay);
      const session =
        connection.status === "ready" ? connection.session : undefined;
      if (
        !session ||
        connection.cached ||
        !channelContext ||
        connection.scope !== channelContext.scope ||
        connection.viewer !== channelContext.viewer
      )
        return null;
      return (
        <ChannelUsage
          key={`${channelContext.scope}:${channelContext.channelId}`}
          session={session}
          channelId={channelContext.channelId}
        />
      );
    },
  });
};
