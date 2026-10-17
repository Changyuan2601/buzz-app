import { useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { messageCopyLink } from "../../features/messages/message-copy";
import {
  linkedDraftKey,
  type LinkedChat,
} from "../../features/solo/linked-chat";
import { writeView } from "../../shared/view-state";
import {
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { soloDraftTarget } from "../../features/channel-navigation/routes";

export function canStartLinkedChat(session: RelaySession, channelId: string) {
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  return !!(
    session.viewer &&
    channel &&
    !channel.cached &&
    !channel.archived &&
    !channel.readOnly &&
    ["stream", "forum"].includes(channel.channelType ?? "") &&
    channel.members?.includes(session.viewer) &&
    session.channelWrites.available
  );
}

/** Inline submenu: the existing menu tree owns positioning and dismissal. */
export function StartLinkedChat({
  session,
  navigation,
  channelId,
  message,
}: {
  session: RelaySession;
  navigation: Navigation;
  channelId: string;
  message?: ChannelMessage;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const notify = useToastNotification();
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  const start = async (share: boolean) => {
    if (busy || !canStartLinkedChat(session, channelId) || !channel) return;
    setBusy(true);
    try {
      const link = message
        ? messageCopyLink(message, session.scope)
        : `buzz://channel/${encodeURIComponent(channelId)}`;
      if (!link)
        throw new Error(
          "This source is not available. Reopen it and try again.",
        );
      const source: LinkedChat = {
        channelId,
        channelName: channel.name,
        link,
        share,
        ...(message
          ? { threadRootId: message.threadRootId ?? message.id }
          : {}),
      };
      if (!writeView(session.scope, linkedDraftKey(id), source))
        throw new Error(
          "Your new chat draft couldn’t be saved. Nothing was created or shared.",
        );
      const opened = await navigation.open(
        soloDraftTarget(session.scope, { linked: id }),
      );
      if (opened.status === "failed")
        throw new Error("The Solo chat couldn’t open. Try again.");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : String(reason),
        "error",
      );
      setBusy(false);
    }
  };
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger
        disabled={busy || !canStartLinkedChat(session, channelId)}
      >
        Start Solo chat
      </MenuSubmenuTrigger>
      <MenuSubmenuPopup size="compact" aria-label="Start Solo chat">
        <MenuItem disabled={busy} onClick={() => void start(false)}>
          Private chat
        </MenuItem>
        <MenuItem disabled={busy} onClick={() => void start(true)}>
          Shared chat
        </MenuItem>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}
