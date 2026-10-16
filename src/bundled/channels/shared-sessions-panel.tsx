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
import { sessionLinkTarget } from "../sessions/SessionsPage";
import { SharedSessions } from "./SharedSessions";

const targetPrefix = "buzz:shared-sessions:";
export const sharedSessionsTarget = (channelId: string) =>
  `${targetPrefix}${channelId}`;
const targetChannel = (target: string) => {
  const id = target.startsWith(targetPrefix)
    ? target.slice(targetPrefix.length)
    : "";
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(id) ? id : undefined;
};
const icon = <FileTextIcon size="1rem" aria-hidden="true" />;

/** Contribute to the existing tab owner; no new panel or navigation contract. */
export function registerSharedSessions(ctx: Context) {
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
        aria-label="Toggle shared sessions"
        title="Shared sessions"
        aria-expanded={pressed}
        onClick={() => {
          if (available()) toggle(sharedSessionsTarget(context.channelId));
        }}
      />
    );
  }
  function Content({ target, channelContext }: PanelProps) {
    usePanelTabTitle("Shared sessions", icon);
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
      return (
        <p role="status">Connect to this channel to view shared sessions.</p>
      );
    return (
      <SharedSessions
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
          const destination = sessionLinkTarget(
            `buzz://channel/${id}`,
            current.scope,
            current.viewer,
          );
          if (destination) void ctx.navigation.open(destination);
        }}
      />
    );
  }
  ctx.panels.register({
    id: "shared-sessions",
    title: "Shared sessions",
    channelPlacement: "tab",
    matches: (target) => !!targetChannel(target),
    channelLauncher: Launcher,
    component: Content,
  });
}
