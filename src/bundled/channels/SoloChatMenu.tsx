import {
  type ComponentProps,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { conversionLabel } from "../../features/solo/conversion";
import {
  soloShareAttempt,
  useSoloShareAttempts,
} from "../../features/solo/share-attempt";
import { canConvertToChannel } from "../../features/solo/ConvertToChannel";
import { canShareConversation } from "../../features/solo/share";
import { canEditLifetime } from "../../features/solo/Lifetime";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  CopyIcon,
  FolderSimpleIcon,
  GearIcon,
  HashIcon,
  PencilSimpleIcon,
  ShareIcon,
} from "../../shared/design-system/icons";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { ChannelReadMenuItem } from "./ChannelReadMenuItem";

/** The one action list for a Solo chat. Its hosts own the dialogs it opens. */
export function SoloChatMenuItems({
  session,
  channel,
  onShare,
  onConvert,
  onMove,
  onNewWorkspace,
  onCopy,
  onSettings,
  onRename,
  onLifecycle,
  onReadResult,
}: {
  session: RelaySession;
  channel: ChannelSummary;
  onShare(): void;
  onConvert(): void;
  onMove(projectId?: string): void;
  onNewWorkspace(): void;
  onCopy(value: string, label: string): void;
  onSettings(): void;
  onRename(): void;
  /** Absent where no owner can confirm lifecycle actions. */
  onLifecycle?: ((action: ChannelLifecycleAction) => void) | undefined;
  /** The menu closes at once; its host reports a failed read change. */
  onReadResult(error?: string): void;
}) {
  const handoff = useChannelNavigation();
  const shareAttempts = useSoloShareAttempts(session);
  const preferences = session.soloPreferences;
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const groups = snapshot.data?.sections ?? [];
  const assigned = snapshot.data?.assignments?.[channel.id];
  const grouped = groups.some((group) => group.id === assigned);
  // Archived chats keep only what still applies, including Unarchive.
  const active = !channel.archived;
  const readable = session.unread.sync().capability === "frontier-sync";
  const renameable = canEditLifetime(session, channel);
  return (
    <>
      {readable && (
        <ChannelReadMenuItem
          unread={session.unread}
          channelId={channel.id}
          pending={false}
          closeOnClick
          run={(action) =>
            action().then(
              () => onReadResult(),
              (error: unknown) =>
                onReadResult(
                  error instanceof Error
                    ? error.message
                    : "Read state couldn’t be saved. Try again.",
                ),
            )
          }
        />
      )}
      {active && (
        <MenuItem
          disabled={!canShareConversation(session, channel)}
          onClick={onShare}
        >
          <MenuIcon>
            <ShareIcon size={16} />
          </MenuIcon>
          Share
        </MenuItem>
      )}
      {renameable && (
        <MenuItem onClick={onRename}>
          <MenuIcon>
            <PencilSimpleIcon size={16} />
          </MenuIcon>
          Rename
        </MenuItem>
      )}
      {active && canConvertToChannel(session, channel) && (
        <MenuItem
          disabled={shareAttempts.has(channel.id)}
          onClick={() => {
            if (!soloShareAttempt(session, channel.id)) onConvert();
          }}
        >
          <MenuIcon>
            <HashIcon size={16} />
          </MenuIcon>
          {conversionLabel(session, channel.id)}
        </MenuItem>
      )}
      {(readable || active || renameable) && <MenuSeparator />}
      {active && (
        <MenuSubmenu>
          <MenuSubmenuTrigger disabled={!preferences.writable}>
            <MenuIcon>
              <FolderSimpleIcon size={16} />
            </MenuIcon>
            Move to
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup aria-label="Workspace">
            {grouped && <MenuItem onClick={() => onMove()}>Chats</MenuItem>}
            {groups.map((group) => (
              <MenuItem key={group.id} onClick={() => onMove(group.id)}>
                {group.name}
              </MenuItem>
            ))}
            <MenuItem onClick={onNewWorkspace}>New workspace…</MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      )}
      <MenuSubmenu>
        <MenuSubmenuTrigger>
          <MenuIcon>
            <CopyIcon size={16} />
          </MenuIcon>
          Copy
        </MenuSubmenuTrigger>
        <MenuSubmenuPopup aria-label="Copy chat">
          <MenuItem onClick={() => onCopy(channel.name, "Chat name")}>
            Copy chat name
          </MenuItem>
          <MenuItem onClick={() => onCopy(channel.id, "Chat ID")}>
            Copy chat ID
          </MenuItem>
          <MenuItem
            onClick={() =>
              onCopy(
                `buzz://channel/${encodeURIComponent(channel.id)}`,
                "Chat link",
              )
            }
          >
            Copy link to chat
          </MenuItem>
        </MenuSubmenuPopup>
      </MenuSubmenu>
      {onLifecycle && !channel.readOnly && !channel.cached && (
        <ChannelLifecycleMenu
          channelId={channel.id}
          lifecycle={session.channelLifecycle}
          disabled={!!handoff?.lifecycleDialog}
          separator
          noun="chat"
          archiveLabel="Archive"
          choose={onLifecycle}
        />
      )}
      <MenuItem
        disabled={
          !!channel.readOnly ||
          (!session.canvas.available && !canEditLifetime(session, channel))
        }
        onClick={onSettings}
      >
        <MenuIcon>
          <GearIcon size={16} />
        </MenuIcon>
        Chat settings…
      </MenuItem>
    </>
  );
}

/** Copies a chat detail and reports the result after the menu closes. */
export function useChatCopy() {
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const copying = useRef(false);
  const copy = async (value: string, label: string) => {
    if (copying.current) return;
    copying.current = true;
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ text: `${label} copied`, error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy. Try again from the chat menu.",
        error: true,
      });
    } finally {
      copying.current = false;
    }
  };
  return [
    (value: string, label: string) => void copy(value, label),
    notice && (
      <ToastNotice
        title={notice.text}
        tone={notice.error ? "error" : "success"}
        timeout={notice.error ? 0 : 4000}
        onDismiss={() => setNotice(undefined)}
      />
    ),
  ] as const;
}

export function NewWorkspaceDialog({
  name,
  create,
  close,
  finalFocus,
}: {
  name: string;
  create: (name: string) => boolean;
  close: () => void;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const [value, setValue] = useState("");
  const [blocked, setBlocked] = useState(false);
  const form = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      size="compact"
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Create new workspace"
      description={`Move ${name} into a personal workspace that syncs across Buzz.`}
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            form={form}
            type="submit"
            variant="prominent"
            disabled={!value.trim()}
          >
            Create and move
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) setBlocked(!create(value.trim()));
        }}
      >
        <Input
          ref={input}
          aria-label="Workspace name"
          placeholder="Workspace name"
          required
          maxLength={80}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
      {blocked && (
        <p role="alert">
          Workspaces are unavailable. Close this dialog and retry.
        </p>
      )}
    </Dialog>
  );
}
