import { readShareBack, shareBackKey } from "../../features/solo/linked-chat";
import { writeView } from "../../shared/view-state";
import {
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { SoloTitle } from "../../features/solo/SoloPresentation";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { DotsThreeIcon, GearIcon } from "../../shared/design-system/icons";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import {
  NewWorkspaceDialog,
  SoloChatMenuItems,
  useChatCopy,
} from "./SoloChatMenu";
import { SoloShare } from "./SoloShare";
import { ToastNotice } from "../../shared/design-system/ui/Toast";

/** The header of a conversation shown with the Solo treatment. */
export function SoloHeading({
  session,
  scope,
  channel,
  navigator,
  signal,
  children,
  paneToggle,
  onConvert,
  onLifecycle,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  navigator?: Navigation | undefined;
  signal?: AbortSignal | undefined;
  /** Panel launchers, owned by the conversation page. */
  children?: ReactNode;
  /** The tab pane toggle, owned by the conversation page; it ends the header. */
  paneToggle?: ReactNode;
  onConvert(trigger: HTMLElement | null): void;
  onLifecycle(action: ChannelLifecycleAction, trigger?: HTMLElement): void;
}) {
  const [shareBack, setShareBack] = useState(() =>
    readShareBack(scope, channel.id),
  );
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // Each dialog returns focus to the control that opened it.
  const [settingsOpen, setSettingsOpen] = useState<{
    visit: AbortSignal | undefined;
    trigger: RefObject<HTMLButtonElement | null>;
  }>();
  const [sharing, setSharing] = useState<{ visit: AbortSignal | undefined }>();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [copy, copyNotice] = useChatCopy();
  const [readError, setReadError] = useState<string>();
  // The sidebar may be hidden, so a move started here reports its own failure.
  const preferences = session.soloPreferences;
  const placement = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const [moving, setMoving] = useState(false);
  const failedMove = moving
    ? placement.moves?.find(
        (move) => move.channelId === channel.id && move.error,
      )
    : undefined;
  return (
    <>
      <SoloTitle
        channel={channel}
        // Archived chats keep their lifecycle actions, including Unarchive.
        actions={
          <>
            {!channel.readOnly && !channel.cached && (
              <MenuRoot>
                <MenuTrigger
                  render={
                    <IconButton
                      ref={actionsTrigger}
                      size="toolbar"
                      aria-label="Chat actions"
                      title="Chat actions"
                      icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
                    />
                  }
                />
                <MenuPopup aria-label="Chat actions" align="end">
                  <SoloChatMenuItems
                    session={session}
                    channel={channel}
                    onShare={() => setSharing({ visit: signal })}
                    onConvert={() => onConvert(actionsTrigger.current)}
                    onMove={(projectId) => {
                      setMoving(true);
                      void preferences
                        .assign(channel.id, projectId)
                        .catch(() => {});
                    }}
                    onNewWorkspace={() => setCreatingWorkspace(true)}
                    onCopy={copy}
                    onSettings={() =>
                      setSettingsOpen({
                        visit: signal,
                        trigger: actionsTrigger,
                      })
                    }
                    onLifecycle={(action) =>
                      onLifecycle(action, actionsTrigger.current ?? undefined)
                    }
                    onReadResult={setReadError}
                  />
                </MenuPopup>
              </MenuRoot>
            )}
            {!channel.archived && paneToggle}
          </>
        }
      >
        <ChannelMembersButton session={session} channelId={channel.id} />
        {children}
        <SoloShare
          key={channel.id}
          navigator={navigator}
          session={session}
          channel={channel}
          signal={signal}
          onConvert={onConvert}
          initialDestination={shareBack?.channelId}
          destinationThread={shareBack?.threadRootId}
          initialOpen={!!shareBack}
          autoShare={!!shareBack && !shareBack.attempted}
          initialMessageId={shareBack?.messageId}
          onAttempt={async () => {
            if (!shareBack) return;
            if (
              !writeView(scope, shareBackKey(channel.id), {
                ...shareBack,
                attempted: true,
              })
            )
              throw new Error(
                "The share choice couldn’t be saved. Retry sharing.",
              );
            // Never share an empty/unsent chat, nor retry a failed first send implicitly.
            try {
              await session.channelWrites.delivered(
                shareBack.firstMessageId,
                undefined,
                false,
                false,
              );
            } catch {
              // Failed automatic handoff must not gate every future manual Share.
              writeView(scope, shareBackKey(channel.id), null);
              setShareBack(undefined);
              throw new Error(
                "The first message wasn’t confirmed. Check Outbox before explicitly sharing this chat.",
              );
            }
          }}
          onLinkQueued={(messageId) => {
            if (
              shareBack &&
              !writeView(scope, shareBackKey(channel.id), {
                ...shareBack,
                attempted: true,
                messageId,
              })
            )
              throw new Error(
                "The link receipt couldn’t be saved. Check Outbox before retrying.",
              );
          }}
          onStartOver={() => {
            writeView(scope, shareBackKey(channel.id), null);
            setShareBack(undefined);
          }}
          onShared={() => {
            writeView(scope, shareBackKey(channel.id), null);
            setShareBack(undefined);
          }}
          onClose={() => {
            if (readShareBack(scope, channel.id)?.attempted) return;
            writeView(scope, shareBackKey(channel.id), null);
            setShareBack(undefined);
          }}
        />
        <IconButton
          ref={settingsTrigger}
          size="toolbar"
          aria-label="Chat settings"
          title="Chat settings"
          icon={<GearIcon size="1rem" aria-hidden="true" />}
          disabled={
            !!channel.readOnly ||
            (!session.canvas.available && !canEditLifetime(session, channel))
          }
          onClick={() =>
            setSettingsOpen({ visit: signal, trigger: settingsTrigger })
          }
        />
      </SoloTitle>
      {sharing && (
        <SoloShare
          navigator={navigator}
          session={session}
          channel={channel}
          signal={sharing.visit}
          onConvert={onConvert}
          finalFocus={() => actionsTrigger.current ?? false}
          initialOpen
          renderTrigger={() => null}
          onClose={() => setSharing(undefined)}
        />
      )}
      {creatingWorkspace && (
        <NewWorkspaceDialog
          name={channel.name}
          finalFocus={actionsTrigger}
          close={() => setCreatingWorkspace(false)}
          create={(name) => {
            if (!preferences.writable) return false;
            setMoving(true);
            void preferences
              .createAndAssign(channel.id, { id: crypto.randomUUID(), name })
              .catch(() => {});
            setCreatingWorkspace(false);
            return true;
          }}
        />
      )}
      {copyNotice}
      {failedMove?.error && (
        <ToastNotice
          key={`${failedMove.id}:${failedMove.error}`}
          title="Chat wasn’t moved"
          description={failedMove.error}
          onDismiss={() => {
            preferences.dismissMoveError(channel.id);
            setMoving(false);
          }}
        >
          <Button
            size="sm"
            disabled={!preferences.writable}
            onClick={() =>
              void preferences.retryMove(channel.id).catch(() => {})
            }
          >
            Retry move
          </Button>
        </ToastNotice>
      )}
      {readError && (
        <ToastNotice
          title="Read state couldn’t be saved"
          description={readError}
          onDismiss={() => setReadError(undefined)}
        />
      )}
      {settingsOpen && (
        <WorkspaceSettings
          signal={settingsOpen.visit}
          finalFocus={settingsOpen.trigger}
          key={channel.id}
          session={session}
          scope={scope}
          target={{ kind: "chat", id: channel.id, name: channel.name }}
          close={() => setSettingsOpen(undefined)}
        />
      )}
    </>
  );
}
