import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import {
  ConversationChannel,
  ConversationThread,
} from "../../features/conversation/Conversation";
import { ConversationPresentation } from "../../features/conversation/ConversationPresentation";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { NavigationScope } from "../../features/navigation/targets";
import type { Navigation } from "../../features/navigation/controller";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import { ChannelPreview } from "./ChannelPreview";
import { useChannelLabels } from "../channels/useChannelLabels";
import { channelIcon } from "../../features/channels/channel-icon";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArchiveIcon,
  ArchiveOffIcon,
  ArrowSquareOutIcon,
  ChatCircleIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Inbox.module.css";
import type { ArchiveShortcut } from "./InboxPage";

export function InboxDetail({
  item,
  target,
  session,
  scope,
  navigator,
  extensions,
  host,
  channelName,
  previewIncomplete,
  archiveAction,
  archiveShortcut,
  onBack,
  resizeHandle,
}: {
  resizeHandle?: ReactNode;
  item: InboxItem;
  target: { channelId: string; messageId: string; rootId?: string };
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
  host: ConversationHostServices;
  channelName: string;
  previewIncomplete?: "loading" | "error" | undefined;
  archiveAction?:
    | { archived: boolean; disabled: boolean; run(): void }
    | undefined;
  archiveShortcut?: ArchiveShortcut | undefined;
  onBack(): void;
}) {
  const archiveLabel = archiveAction?.archived
    ? "Restore conversation"
    : "Archive conversation";
  const [error, setError] = useState<string>();
  const placeholderClose = useRef<HTMLButtonElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const readerFocus = useRef<HTMLElement | null>(null);
  const withheldFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // The one visible header owns entry focus; readers may reveal the exact target.
    placeholderClose.current?.focus({ preventScroll: true });
  }, []);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channel = list.channels.find(
    (candidate) => candidate.id === item.channelId,
  );
  const available =
    !!channel &&
    !channel.cached &&
    !channel.archived &&
    !channel.readOnly &&
    !!channel.members?.includes(scope.viewer);
  // Inbox keys this component by the captured visit. Revalidation withholds an
  // admitted reader, but must not recreate its reveal request or editor.
  const [admitted, setAdmitted] = useState(false);
  // A late reply can regroup a session's opening message into its thread;
  // keep the reader this visit opened with.
  const flat =
    item.target.kind === "channel" ||
    (channel?.channelType === "session" && !item.thread);
  const [timeline, setTimeline] = useState<boolean>();
  if (available && timeline === undefined) setTimeline(flat);
  useEffect(() => {
    if (!available) setAdmitted(false);
    else if (!previewIncomplete) setAdmitted(true);
  }, [available, previewIncomplete]);
  useLayoutEffect(() => {
    if (!available) {
      readerFocus.current = withheldFocus.current = null;
    } else if (previewIncomplete) {
      // Capture events retain ownership across the host's hidden/inert mutation,
      // which can already have blurred the reader before layout effects run.
      if (
        readerFocus.current &&
        (document.activeElement === readerFocus.current ||
          document.activeElement === document.body)
      ) {
        withheldFocus.current = readerFocus.current;
        readerFocus.current = null;
        placeholderClose.current?.focus({ preventScroll: true });
      }
    } else {
      const prior = withheldFocus.current;
      withheldFocus.current = null;
      // Close's blur cancels the handoff, including an intentional blur to body.
      // The header remains mounted during recovery; restore only while it owns focus.
      if (
        prior?.isConnected &&
        reader.current?.contains(prior) &&
        document.activeElement === placeholderClose.current &&
        !prior.closest('[hidden], [inert], [aria-hidden="true"]') &&
        !prior.matches(':disabled, [aria-disabled="true"]') &&
        prior.getClientRects().length
      )
        prior.focus({ preventScroll: true });
    }
  }, [available, previewIncomplete]);
  useEffect(() => {
    // A retired portal releases its modal inert boundary in passive cleanup.
    if (
      previewIncomplete &&
      withheldFocus.current &&
      !withheldFocus.current.isConnected &&
      document.activeElement === document.body
    )
      placeholderClose.current?.focus({ preventScroll: true });
  }, [previewIncomplete]);
  const headerRoster = useMemo(() => (channel ? [channel] : []), [channel]);
  const { channels: labelledChannels } = useChannelLabels(
    headerRoster,
    session.profiles,
    session.names,
  );
  const conversationName =
    labelledChannels[0]?.name ?? channel?.name ?? channelName;
  const dmName = conversationName;
  const ChannelIcon = channelIcon(channel);
  const open = async () => {
    const destination = {
      version: 1 as const,
      kind: "conversation" as const,
      scope,
      channelId: target.channelId,
      messageId: target.messageId,
      ...(target.rootId ? { threadRootId: target.rootId } : {}),
    };
    const result = await navigator.open(destination);
    if (result.status === "failed")
      setError("This conversation could not be opened. Try again.");
  };
  const dismissOnEscape = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      onBack();
    }
  };
  const archiveEnabled =
    !!archiveAction &&
    !archiveAction.disabled &&
    available &&
    !previewIncomplete;
  // The Archive shortcut is this visible header's button, under its enablement.
  useLayoutEffect(() => {
    if (!archiveShortcut || !archiveAction || !archiveEnabled) return;
    const current = archiveAction.run;
    archiveShortcut.current = current;
    return () => {
      if (archiveShortcut.current === current)
        archiveShortcut.current = undefined;
    };
  });
  const openAction = (
    <Tooltip content="Open in channel">
      <IconButton
        size="sm"
        onKeyDown={dismissOnEscape}
        aria-label="Open in channel"
        onClick={() => void open()}
        icon={<ArrowSquareOutIcon size="1rem" />}
      />
    </Tooltip>
  );
  return (
    <section
      className={styles.detail}
      aria-label="Inbox detail"
      onKeyDown={(event) => {
        // Detail owns dismissal regardless of reader/placeholder. Children may
        // consume Escape; ThreadPanel already stops its own close event.
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      {resizeHandle}
      <PanelHeader
        title={
          <div className="panel-header-label">
            <span className="panel-header-label-icon" aria-hidden="true">
              {channel?.channelType === "dm" ? (
                <ChatCircleIcon size="1rem" />
              ) : (
                <ChannelIcon size="1rem" />
              )}
            </span>
            <h2 className={styles.detailHeadingTitle}>
              <button
                type="button"
                className={styles.detailHeadingLink}
                title={
                  channel?.channelType === "dm"
                    ? "Open conversation"
                    : target.rootId
                      ? "Open full thread"
                      : "Open in channel"
                }
                onClick={() => void open()}
              >
                {conversationName}
              </button>
            </h2>
          </div>
        }
        actions={
          <>
            {archiveAction && (
              <Tooltip content={archiveLabel}>
                <IconButton
                  size="sm"
                  variant="ghost"
                  disabled={!archiveEnabled}
                  onClick={archiveAction.run}
                  onKeyDown={dismissOnEscape}
                  aria-label={archiveLabel}
                  icon={
                    archiveAction.archived ? (
                      <ArchiveOffIcon size="1rem" aria-hidden="true" />
                    ) : (
                      <ArchiveIcon size="1rem" aria-hidden="true" />
                    )
                  }
                />
              </Tooltip>
            )}
            {openAction}
            <Tooltip content="Close detail">
              <IconButton
                ref={placeholderClose}
                onBlur={() => {
                  withheldFocus.current = null;
                }}
                size="sm"
                onKeyDown={dismissOnEscape}
                aria-label="Close detail"
                onClick={onBack}
                icon={<XIcon size="1rem" />}
              />
            </Tooltip>
          </>
        }
      />
      <div className={styles.detailBody}>
        {error && (
          <p role="alert" className={styles.notice}>
            {error}
          </p>
        )}
        {previewIncomplete ? (
          <p
            role={previewIncomplete === "error" ? "alert" : "status"}
            className={styles.notice}
          >
            {previewIncomplete === "error"
              ? "Preview unavailable. Retry inbox."
              : "Preview updating…"}
          </p>
        ) : !available ? (
          <p role="status" className={styles.notice}>
            This conversation is unavailable. Open it in Channels to check
            access.
          </p>
        ) : null}
        {available && (admitted || !previewIncomplete) && (
          <ConversationPresentation value={!previewIncomplete}>
            <div
              className={styles.detailBody}
              ref={reader}
              onFocusCapture={(event) => {
                readerFocus.current = event.target;
              }}
              onBlurCapture={(event) => {
                // Ignore loss caused by withholding/removing an owned portal,
                // not deliberate moves or blur while the reader is visible.
                if (
                  event.relatedTarget ||
                  (event.target.isConnected && !event.currentTarget.hidden)
                )
                  readerFocus.current = null;
              }}
              hidden={!!previewIncomplete}
              inert={!!previewIncomplete}
              // The flex class must not override native hidden presentation.
              style={previewIncomplete ? { display: "none" } : undefined}
            >
              <ConversationChannel
                session={session}
                scope={session.scope}
                extensions={extensions}
                host={host}
                threadId={(timeline ?? flat) ? undefined : target.messageId}
                channel={channel}
                channelName={channelName}
                active={false}
              >
                {(timeline ?? flat) ? (
                  <ChannelPreview
                    channelName={
                      channel.channelType === "dm"
                        ? `DM with ${dmName}`
                        : channelName
                    }
                    anchor={target.messageId}
                  />
                ) : (
                  <ConversationThread
                    messageId={target.messageId}
                    revealSelected
                  />
                )}
              </ConversationChannel>
            </div>
          </ConversationPresentation>
        )}
      </div>
    </section>
  );
}
