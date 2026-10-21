import { useMemo, useSyncExternalStore } from "react";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";
import { ConversationChannel, ConversationThread } from "./Conversation";
import type { ConversationHostServices } from "./ConversationHost";

/** The host owns conversation behavior; the page owns its task and placement. */
export type EmbeddedThreadProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "messageId"
> & { managedRecipient?: string | undefined };
type Props = EmbeddedThreadProps & {
  host: ConversationHostServices;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};

/** Channel visits and recovery span threads; overlays belong to one thread. */
export function EmbeddedThread({
  session,
  scope,
  channelId,
  channelName,
  messageId,
  host,
  extensions,
  managedRecipient,
}: Props) {
  const managedSession = useMemo(
    () =>
      managedRecipient
        ? Object.freeze({
            ...session,
            messages: session.messagesForRecipient(managedRecipient),
          })
        : session,
    [session, managedRecipient],
  );
  const { channels } = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = channels.find((item) => item.id === channelId);
  return (
    <ConversationChannel
      key={messageViewKey(managedSession, scope, channelId)}
      session={managedSession}
      scope={scope}
      extensions={extensions}
      host={host}
      threadId={messageId}
      channel={{
        id: channelId,
        name: channelName,
        channelType: channel?.channelType,
        creator: channel?.creator,
      }}
    >
      <ConversationThread messageId={messageId} />
    </ConversationChannel>
  );
}
