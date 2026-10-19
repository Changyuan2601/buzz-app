import { localOriginPreview } from "../../features/solo/local-origin-preview";
import { useEffect, useRef, useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { parseChannelOrigin } from "../../features/relay/channel-origin";
import { linkedDraftKey } from "../../features/solo/linked-chat";
import { writeView } from "../../shared/view-state";
import { MenuItem } from "../../shared/design-system/ui/Menu";
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
    session.channelWrites.available &&
    (session.channelWrites.originSupported || localOriginPreview()) &&
    parseChannelOrigin({ channelId })
  );
}

/** Local intent only; first send creates the chat and its immutable source together. */
export async function startLinkedChat(
  session: RelaySession,
  navigation: Navigation,
  channelId: string,
  message?: ChannelMessage,
) {
  if (!canStartLinkedChat(session, channelId))
    throw new Error("This community does not support linked chats here yet.");
  if (
    message &&
    (message.channelId !== channelId ||
      (message.delivery && !["accepted", "seen"].includes(message.delivery)))
  )
    throw new Error("This message is not available as a source.");
  const source = parseChannelOrigin({
    channelId,
    ...(message
      ? {
          messageId: message.id,
          ...(message.threadRootId && message.threadRootId !== message.id
            ? { threadRootId: message.threadRootId }
            : {}),
        }
      : {}),
  });
  if (!source) throw new Error("This source is invalid.");
  const id = crypto.randomUUID();
  if (!writeView(session.scope, linkedDraftKey(id), source))
    throw new Error(
      "Your new chat draft couldn’t be saved. Nothing was created.",
    );
  const opened = await navigation.open(
    soloDraftTarget(session.scope, { linked: id }),
  );
  if (opened.status === "failed")
    throw new Error("The Solo chat couldn’t open. Try again.");
}

export function StartLinkedChat({
  session,
  navigation,
  channelId,
}: {
  session: RelaySession;
  navigation: Navigation;
  channelId: string;
}) {
  const [busy, setBusy] = useState(false);
  const notify = useToastNotification();
  return (
    <MenuItem
      disabled={busy || !canStartLinkedChat(session, channelId)}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void startLinkedChat(session, navigation, channelId).catch((error) => {
          notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
          setBusy(false);
        });
      }}
    >
      Start Solo chat
    </MenuItem>
  );
}

/** The message-action host invokes this after dismissing its menu. */
export function StartLinkedMessage({
  session,
  navigation,
  message,
  close,
}: {
  session: RelaySession;
  navigation: Navigation;
  message: ChannelMessage;
  close(): void;
}) {
  const started = useRef(false);
  const notify = useToastNotification();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startLinkedChat(session, navigation, message.channelId, message)
      .catch((error) =>
        notify(error instanceof Error ? error.message : String(error), "error"),
      )
      .finally(close);
  }, [session, navigation, message, close, notify]);
  return null;
}
