import {
  createContext,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../relay/contracts";
import {
  ChannelTimeline,
  type ChannelTimelineProps,
} from "../messages/ChannelTimeline";
import {
  MessageComposer,
  type MessageComposerProps,
} from "../messages/MessageComposer";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../messages/MessageManagement";
import { MediaReviewViewer } from "../messages/MediaReviewViewer";
import { ThreadPanel, type ThreadPanelProps } from "../messages/ThreadPanel";
import {
  ConversationHost,
  type ConversationHostServices,
  type ConversationInteractions,
} from "./ConversationHost";

/** Everything a reader or composer needs from its channel, supplied once. */
type Conversation = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "extensions"
> &
  ConversationInteractions & { sessionConversation: boolean };
type Shared = keyof Conversation;
/** Pages supply only their own policy, and may relabel the channel. */
type Own<P> = Omit<P, Shared> &
  Partial<Pick<P, Extract<keyof P, "channelName">>>;

/** A page's open review; the scope supplies its conversation. */
export type MediaReview = Pick<
  ComponentProps<typeof MediaReviewViewer>,
  | "messageId"
  | "attachment"
  | "initialTime"
  | "hasComments"
  | "restoreFocus"
  | "close"
>;

const Context = createContext<Conversation | undefined>(undefined);
export function useConversation() {
  const value = useContext(Context);
  if (!value)
    throw new Error("Conversation readers need a ConversationChannel");
  return value;
}

type ChannelProps = Pick<Conversation, "session" | "scope" | "extensions"> & {
  /** Absent while a page has no selected channel; readers need one. */
  channel?:
    | {
        id: string;
        name: string;
        channelType?: ChannelSummary["channelType"] | undefined;
      }
    | undefined;
  /** Presentation name, when the page labels the channel differently. */
  channelName?: string | undefined;
  /** Whether the channel visit marks it read; see MessageManagement. */
  active?: boolean | undefined;
  children: ReactNode;
} & (
    | {
        interactions: ConversationInteractions;
        /** The page owns when a review opens and retires. */
        mediaReview?: MediaReview | undefined;
        host?: undefined;
      }
    | {
        /** Pages without their own placement use the shared dialog host. */
        host: ConversationHostServices;
        /** Overlays belong to one thread; recovery spans the channel. */
        threadId?: string | undefined;
        interactions?: undefined;
        mediaReview?: undefined;
      }
  );

/** One channel's editing recovery, visit and interactions for every reader in it. */
export function ConversationChannel(props: ChannelProps) {
  const { session, scope, extensions, channel, active, children } = props;
  const channelName = props.channelName ?? channel?.name ?? "";
  // One stable element, so selecting a channel never remounts the page below.
  const provide = (
    interactions: ConversationInteractions,
    review = props.mediaReview,
  ) => (
    <Provider
      session={session}
      scope={scope}
      extensions={extensions}
      channel={channel}
      channelName={channelName}
      interactions={interactions}
    >
      {children}
      {review && <ConversationMediaReview {...review} />}
    </Provider>
  );
  return (
    <MessageManagement
      session={session}
      channelId={channel?.id}
      active={active}
    >
      {props.host ? (
        <>
          {/* Dialog-hosted pages have no layout of their own for recovery. */}
          <MessageManagementStatus />
          {channel && (
            <ConversationHost
              key={props.threadId}
              host={props.host}
              session={session}
              scope={scope}
              channelId={channel.id}
              channelName={channelName}
              threadId={props.threadId}
            >
              {provide}
            </ConversationHost>
          )}
        </>
      ) : (
        provide(props.interactions)
      )}
    </MessageManagement>
  );
}

/** Rows are memoized; the environment changes only with its parts. */
function Provider({
  children,
  session,
  scope,
  extensions,
  channel,
  channelName,
  interactions: { onOpenLink, canOpenLink, onOpenMediaReview },
}: Pick<ChannelProps, "session" | "scope" | "extensions" | "channel"> & {
  channelName: string;
  interactions: ConversationInteractions;
  children: ReactNode;
}) {
  const id = channel?.id;
  const sessionConversation = channel?.channelType === "session";
  const value = useMemo(
    () =>
      id
        ? {
            session,
            scope,
            extensions,
            channelId: id,
            channelName,
            sessionConversation,
            onOpenLink,
            canOpenLink,
            onOpenMediaReview,
          }
        : undefined,
    [
      session,
      scope,
      extensions,
      id,
      channelName,
      sessionConversation,
      onOpenLink,
      canOpenLink,
      onOpenMediaReview,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function ConversationMediaReview(props: MediaReview) {
  const { session, scope, channelId, channelName, extensions, onOpenLink } =
    useConversation();
  return (
    <MediaReviewViewer
      session={session}
      scope={scope}
      channelId={channelId}
      channelName={channelName}
      extensions={extensions}
      onOpenLink={onOpenLink}
      {...props}
    />
  );
}

export function ConversationThread(props: Own<ThreadPanelProps>) {
  return <ThreadPanel {...useConversation()} {...props} />;
}

export function ConversationTimeline(
  props: Own<Omit<ChannelTimelineProps, "queries">>,
) {
  const { session, sessionConversation: _, ...shared } = useConversation();
  return (
    <ChannelTimeline
      queries={session}
      viewer={session.viewer}
      {...shared}
      {...props}
    />
  );
}

export function ConversationComposer(props: Own<MessageComposerProps>) {
  const { onOpenMediaReview: _, ...shared } = useConversation();
  return <MessageComposer {...shared} {...props} />;
}
