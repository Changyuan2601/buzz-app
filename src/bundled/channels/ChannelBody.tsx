import { MessageLoading } from "../../features/messages/MessageLoading";
import { DetailsSheet } from "../../features/messages/DetailsSheet";
import { threadPlacementPreference } from "../../features/messages/thread-preferences";
import {
  overlayHostFor,
  type ComposerOverlayHost,
} from "../../features/messages/composer-overlay";
import { useConversationPresentation } from "../../features/conversation/ConversationPresentation";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ConversationTimeline,
  ConversationThread,
  useConversation,
} from "../../features/conversation/Conversation";
import type { PageNavigation } from "../../features/navigation/service";
import { useChannelWindow } from "../../features/relay/react";
import { useRecoveryShown } from "../../features/relay/RecoveryNotice";
import { clientMetrics } from "../../features/developer/client-metrics";
import { ArrowSquareOutIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Channels.module.css";

export const ChannelBody = memo(function ChannelBody({
  cached,
  viewer,
  revealMessageId,
  inlineTarget,
  marksRead,
  holding,
  onOpenThread,
  hasThreadTab,
  navigation,
  onContentReady,
  activityLane,
}: {
  onContentReady?(channelId: string): void;
  /** The channel composer follows this body and shows conversation activity. */
  activityLane?: boolean | undefined;
  cached: boolean;
  viewer?: string | undefined;
  navigation?: PageNavigation | undefined;
  revealMessageId?: string | undefined;
  /** One exact visit to a loaded message, without a page navigation. */
  inlineTarget?:
    | Readonly<{ messageId: string; signal: AbortSignal }>
    | undefined;
  /** False: viewing rows marks nothing read. */
  marksRead?: boolean | undefined;
  /** Show the loading notice instead of the list, as while a message is sought. */
  holding?: boolean | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
  /** Whether a thread already has a tab, which it selects instead of reading
   * inline. */
  hasThreadTab?: ((channelId: string, rootId: string) => boolean) | undefined;
}) {
  // The owner's Solo chat is a chat-style timeline that loads history on scroll.
  const {
    session: queries,
    channelId,
    ownSoloConversation: solo,
  } = useConversation();
  const presented = useConversationPresentation();
  const trigger = useRef<HTMLElement | null>(null);
  const [thread, setThread] = useState<{
    messageId: string;
    rootId: string;
    channelId: string;
    host: ComposerOverlayHost;
    revealSelected: boolean;
    replyRequest?: number;
  }>();
  const [threadOpen, setThreadOpen] = useState(false);
  useEffect(() => {
    if (!presented || thread?.channelId !== channelId) {
      setThreadOpen(false);
      setThread(undefined);
    }
  }, [presented, channelId, thread?.channelId]);
  // Stable, so memoized message rows keep their props across window updates.
  const openThread = useCallback(
    (messageId: string, rootId: string, intent?: "reply") => {
      const opener = document.activeElement;
      // Only Inline reads a thread here; other placements, and a thread that
      // already has a tab, open through the workspace's tabs.
      const host =
        threadPlacementPreference() === "inline" &&
        !hasThreadTab?.(channelId, rootId)
          ? overlayHostFor(opener)
          : null;
      if (!host) {
        onOpenThread?.(messageId, rootId, intent);
        return;
      }
      trigger.current = opener instanceof HTMLElement ? opener : null;
      setThread({
        messageId,
        rootId,
        channelId,
        host,
        revealSelected: messageId !== rootId,
        ...(intent === "reply" ? { replyRequest: 1 } : {}),
      });
      setThreadOpen(true);
    },
    [channelId, onOpenThread, hasThreadTab],
  );
  // ChannelWorkspace already keys this lifetime by viewer/scope/generation.
  const continuityKey = useId();
  const window = useChannelWindow(queries.channels, channelId);
  useLayoutEffect(() => {
    clientMetrics.channelMounted(channelId);
    return () => clientMetrics.channelUnmounted(channelId);
  }, [channelId]);
  const recoveryShown = useRecoveryShown(queries.recovery);
  const newest = window.rows.at(-1)?.id;
  const settled = window.status === "ready" || window.status === "error";
  useEffect(() => {
    if (newest || settled) onContentReady?.(channelId);
  }, [channelId, newest, settled, onContentReady]);
  useLayoutEffect(() => {
    // Repeat calls for the same open are ignored; only the first rows count.
    // Any row counts as content, since a saved scroll position may keep the
    // newest one unmounted.
    if (newest)
      clientMetrics.channelRendered(
        channelId,
        () =>
          !!document.querySelector(
            `[data-channel-timeline="${CSS.escape(channelId)}"] [data-message-id]`,
          ),
      );
    else if (settled) clientMetrics.channelEmpty(channelId);
  }, [channelId, newest, settled]);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    else if (!cached && window.status === "error")
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [cached, navigation, window.status]);
  // While the recovery notice shows, it owns the one Retry now; an empty
  // failed timeline waits for it instead of offering a second Retry.
  const timeline =
    window.status === "error" && !window.rows.length && !recoveryShown ? (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        role="alert"
      >
        <p>{window.error}</p>
        <Button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </Button>
      </div>
    ) : holding || (window.status !== "ready" && !window.rows.length) ? (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        data-buzz-launch-pending={!cached ? "required" : undefined}
      >
        <MessageLoading />
      </div>
    ) : (
      <ConversationTimeline
        continuityKey={continuityKey}
        viewer={viewer}
        window={window}
        launchPending={
          !cached &&
          !window.error &&
          (window.status === "idle" ||
            window.status === "loading" ||
            (window.status === "ready" && window.freshness === "cached"))
        }
        {...(onOpenThread ? { onOpenThread: openThread } : {})}
        revealMessageId={revealMessageId}
        inlineTarget={inlineTarget}
        marksRead={marksRead}
        navigation={navigation}
        activityLane={activityLane}
        chatPresentation={solo}
        historyControl={solo ? "scroll" : "button"}
      />
    );
  return (
    <>
      {timeline}
      {thread && presented && thread.channelId === channelId && (
        <DetailsSheet
          open={threadOpen}
          onOpenChange={setThreadOpen}
          onClosed={() => setThread(undefined)}
          host={thread.host}
          containsComposer
          title="Thread"
          closeLabel="Close thread"
          finalFocus={trigger}
          headerActions={
            <IconButton
              aria-label="Open thread in tab"
              variant="glass"
              shape="round"
              size="compact"
              icon={<ArrowSquareOutIcon size={16} aria-hidden="true" />}
              onClick={() => {
                onOpenThread?.(thread.messageId, thread.rootId);
                setThreadOpen(false);
                setThread(undefined);
              }}
            />
          }
        >
          <ConversationThread
            messageId={thread.messageId}
            replyRequest={thread.replyRequest}
            revealSelected={thread.revealSelected}
            initialScroll="latest"
            virtualizeReplies
          />
        </DetailsSheet>
      )}
    </>
  );
});
