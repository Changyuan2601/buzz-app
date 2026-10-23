import { useRef, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import { useRelayConnection } from "../../features/relay/react";
import { useListedChannel } from "../../features/relay/listed-channel";
import { FileTextIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { conversationTarget } from "../../features/channel-navigation/routes";
import { SharedChats } from "./SharedChats";

const targetPrefix = "buzz:shared-sessions:";
export const sharedChatsTarget = (channelId: string) =>
  `${targetPrefix}${channelId}`;
const targetChannel = (target: string) => {
  const id = target.startsWith(targetPrefix)
    ? target.slice(targetPrefix.length)
    : "";
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(id) ? id : undefined;
};
const icon = <FileTextIcon size="1rem" aria-hidden="true" />;

/** Contribute to the existing tab owner; no new panel or navigation contract. */
export function registerSharedChats(ctx: Context) {
  const relay = ctx.relay;
  function Launcher({
    context,
    available,
    pressed,
    toggle,
  }: ChannelLauncherProps) {
    const connection = useRelayConnection(relay);
    const channelType = useListedChannel(
      connection.status === "ready" ? connection.session.channels : undefined,
      context.channelId,
      (channel) => channel?.channelType,
    );
    if (
      connection.status !== "ready" ||
      connection.cached ||
      connection.scope !== context.scope ||
      !["stream", "forum"].includes(channelType ?? "")
    )
      return null;
    return (
      <IconButton
        size="sm"
        variant="ghost"
        icon={icon}
        aria-label="Toggle shared chats"
        title="Shared chats"
        aria-expanded={pressed}
        onClick={() => {
          if (available()) toggle(sharedChatsTarget(context.channelId));
        }}
      />
    );
  }
  function Content({ target, channelContext }: PanelProps) {
    usePanelTabTitle("Shared chats", icon);
    const connection = useRelayConnection(relay);
    const channelId = targetChannel(target);
    const view = useRef<{
      query: string;
      scrollTop: number;
      focusedEntry?: string;
    }>({ query: "", scrollTop: 0 });
    const navigation = useSyncExternalStore(
      ctx.navigation.subscribe,
      ctx.navigation.snapshot,
    );
    const focusRequest =
      navigation.entry.target.kind === "conversation" &&
      navigation.entry.target.panel === "shared-sessions" &&
      navigation.entry.target.channelId === channelId &&
      !navigation.attempt.signal.aborted
        ? navigation.entry.id
        : undefined;
    if (
      connection.status !== "ready" ||
      connection.cached ||
      !channelContext ||
      !channelId ||
      connection.scope !== channelContext.scope ||
      connection.viewer !== channelContext.viewer
    )
      return <p role="status">Connect to this channel to view shared chats.</p>;
    return (
      <SharedChats
        key={`${connection.scope}:${connection.viewer}:${channelId}`}
        view={view.current}
        focusRequest={focusRequest}
        session={connection.session}
        channelId={channelId}
        open={(id) => {
          const current = relay.snapshot();
          if (
            current.status !== "ready" ||
            !current.scope ||
            current.session !== connection.session
          )
            return;
          void ctx.navigation.open(conversationTarget(current.scope, id));
        }}
      />
    );
  }
  ctx.panels.register({
    id: "shared-sessions",
    title: "Shared chats",
    channelPlacement: "tab",
    matches: (target) => !!targetChannel(target),
    channelLauncher: Launcher,
    component: Content,
  });
}
