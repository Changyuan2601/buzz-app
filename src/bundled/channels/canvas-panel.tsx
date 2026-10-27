import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useListedChannel } from "../../features/relay/listed-channel";
import type { PanelProps } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import { FileTextIcon } from "../../shared/design-system/icons";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { CanvasEditor } from "./CanvasEditor";

function eligible(channel: ChannelSummary, session: RelaySession) {
  return (
    !channel.cached &&
    !channel.readOnly &&
    !!channel.members?.includes(session.viewer ?? "")
  );
}

// One element keeps the tab identity stable across renders.
const tabIcon = <FileTextIcon size="1rem" />;

export function registerCanvas(ctx: Context) {
  function Panel({ channelContext }: PanelProps) {
    usePanelTabTitle("Canvas", tabIcon);
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const archived = useListedChannel(
      state.status === "ready" ? state.session.channels : undefined,
      channelContext?.channelId,
      (channel) => !!channel?.archived,
    );
    if (
      !channelContext ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return (
        <p role="status">
          Canvas is unavailable while the connection recovers.
        </p>
      );
    return (
      <CanvasEditor
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        readOnly={archived}
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
}
