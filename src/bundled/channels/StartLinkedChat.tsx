import { ChatCircleIcon } from "../../shared/design-system/icons";
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
  MenuItem,
  MenuIcon,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
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

/** Existing menu tree owns anchoring/dismissal. Neither choice publishes anything yet. */
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
  const [busy, setBusy] = useState(false);
  const notify = useToastNotification();
  async function start(share: boolean) {
    if (busy || !canStartLinkedChat(session, channelId)) return;
    setBusy(true);
    try {
      const link = message
        ? messageCopyLink(message, session.scope)
        : `buzz://channel/${encodeURIComponent(channelId)}`;
      if (!link || (message && message.channelId !== channelId))
        throw new Error("This source is unavailable. Reopen it and try again.");
      const source: LinkedChat = {
        channelId,
        link,
        share,
        ...(message
          ? { threadRootId: message.threadRootId ?? message.id }
          : {}),
      };
      const id = crypto.randomUUID();
      if (!writeView(session.scope, linkedDraftKey(id), source))
        throw new Error(
          "Your new chat draft couldn’t be saved. Nothing was created.",
        );
      const result = await navigation.open(
        soloDraftTarget(session.scope, { linked: id }),
      );
      if (result.status === "failed")
        throw new Error("The Solo chat couldn’t open. Try again.");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  }
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger
        disabled={busy || !canStartLinkedChat(session, channelId)}
      >
        <MenuIcon>
          <ChatCircleIcon size={16} aria-hidden="true" />
        </MenuIcon>
        Start Solo chat
      </MenuSubmenuTrigger>
      <MenuSubmenuPopup size="compact" aria-label="Start Solo chat">
        <MenuItem disabled={busy} onClick={() => void start(false)}>
          Start privately
        </MenuItem>
        <MenuItem disabled={busy} onClick={() => void start(true)}>
          Start and share here
        </MenuItem>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}
