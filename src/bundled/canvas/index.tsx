import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { CanvasEditor } from "../channels/CanvasEditor";

export function eligible(channel: ChannelSummary, session: RelaySession) {
  return (
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived &&
    !!channel.members?.includes(session.viewer ?? "")
  );
}

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  function Panel({ channelContext }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    if (
      !channelContext ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return <p role="status">Connect to this channel to view canvas.</p>;
    return (
      <CanvasEditor
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        canvas={state.session.canvas}
        profiles={state.session.profiles}
        scope={state.scope}
        channelId={channelContext.channelId}
      />
    );
  }
  ctx.panels.register({
    id: "canvas",
    title: "Canvas",
    matches: () => false,
    channelMenu: { label: "View canvas", eligible },
    component: Panel,
  });
};
