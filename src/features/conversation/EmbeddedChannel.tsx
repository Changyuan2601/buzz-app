import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";
import { useChannelWindow } from "../relay/react";
import {
  ConversationChannel,
  ConversationComposer,
  ConversationThread,
  ConversationTimeline,
  useConversation,
} from "./Conversation";
import type { ConversationHostServices } from "./ConversationHost";
import { useConversationPresentation } from "./ConversationPresentation";
import type { EmbeddedThreadProps } from "./EmbeddedThread";
import styles from "./EmbeddedChannel.module.css";

/** The host owns the channel view; the page owns its task and placement. */
export type EmbeddedChannelProps = Pick<
  EmbeddedThreadProps,
  "session" | "scope" | "channelId" | "channelName"
> & {
  /** A top-level message to show and focus in place. */
  messageId?: string | undefined;
  /** Without it, messages show no reply or thread controls. */
  onOpenThread?(messageId: string, threadRootId: string): void;
};
type Props = EmbeddedChannelProps & {
  host: ConversationHostServices;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};

/**
 * The Channels message list and composer of one channel. Message recovery and
 * overlays span the channel; retargeting the message remounts only the view.
 */
export function EmbeddedChannel({
  session,
  scope,
  channelId,
  channelName,
  messageId,
  onOpenThread,
  host,
  extensions,
}: Props) {
  const { channels } = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  return (
    <ConversationChannel
      key={messageViewKey(session, scope, channelId)}
      session={session}
      scope={scope}
      extensions={extensions}
      host={host}
      channel={{
        id: channelId,
        name: channelName,
        channelType: channels.find((channel) => channel.id === channelId)
          ?.channelType,
      }}
    >
      <ChannelView
        key={messageId ?? ""}
        host={host}
        messageId={messageId}
        onOpenThread={onOpenThread}
      />
    </ConversationChannel>
  );
}

function ChannelView({
  host,
  messageId,
  onOpenThread,
}: Pick<EmbeddedChannelProps, "messageId"> & {
  onOpenThread: EmbeddedChannelProps["onOpenThread"] | undefined;
  host: ConversationHostServices;
}) {
  const { session, scope, channelId, channelName, sessionConversation } =
    useConversation();
  const window = useChannelWindow(session.channels, channelId);
  // Cache clear can leave the window idle without remounting this view.
  useEffect(() => {
    if (window.status === "idle") session.channels.ensure(channelId);
  }, [session, channelId, window.status]);
  const [target, setTarget] = useState<AbortSignal>();
  useEffect(() => {
    if (!messageId) return;
    const request = new AbortController();
    setTarget(request.signal);
    return () => request.abort();
  }, [messageId]);
  // A page's thread request acts only while this view is on screen for the
  // page's current connection, as the shared conversation host's overlays do.
  const presented = useConversationPresentation();
  const shown = useRef(false);
  useLayoutEffect(() => {
    shown.current = presented;
    return () => {
      shown.current = false;
    };
  }, [presented]);
  const active = () => {
    const connection = host.relay.snapshot();
    return (
      shown.current &&
      connection.status === "ready" &&
      connection.session === session &&
      connection.scope === scope
    );
  };
  // As in Channels and Inbox, decide once the head settles: a message outside
  // the loaded window opens as its thread, and later arrivals do not switch it.
  const [inTimeline, setInTimeline] = useState<boolean>();
  if (
    messageId &&
    inTimeline === undefined &&
    window.status !== "idle" &&
    window.status !== "loading"
  )
    setInTimeline(
      window.status === "ready" &&
        window.freshness !== "cached" &&
        window.rows.some((row) => row.id === messageId && !row.threadRootId),
    );
  const [sent, setSent] = useState<string>();
  if (messageId && inTimeline === false)
    return <ConversationThread messageId={messageId} revealSelected />;
  return (
    <section
      className={styles.channel}
      aria-label={`Messages in ${channelName}`}
    >
      {window.rows.length > 0 ? (
        <ConversationTimeline
          window={window}
          // Channels keeps its own saved place in this channel.
          transient
          revealMessageId={sent}
          inlineTarget={
            messageId && target && !target.aborted
              ? { messageId, signal: target }
              : undefined
          }
          {...(onOpenThread
            ? {
                onOpenThread: (id: string, rootId: string) => {
                  if (active()) onOpenThread(id, rootId);
                },
              }
            : {})}
        />
      ) : window.status === "error" ? null : (
        <p className={styles.notice} role="status">
          {window.status === "ready" ? "No messages yet." : "Loading messages…"}
        </p>
      )}
      {(window.status === "error" || window.error) && (
        <div className={styles.notice} role="alert">
          <span>{window.error ?? "Could not load messages."}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => session.channels.refresh?.(channelId)}
          >
            Retry messages
          </Button>
        </div>
      )}
      <ConversationComposer
        label={sessionConversation ? "Message this session" : undefined}
        onSend={setSent}
      />
    </section>
  );
}
