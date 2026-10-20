import { parseBuzzLink } from "../navigation/buzz-links";
import { readView } from "../../shared/view-state";

/** One unsent shortcut; the link itself is ordinary editable message content. */
export type LinkedChat = {
  channelId: string;
  link: string;
  threadRootId?: string;
  share: boolean;
};
export type ShareBack = LinkedChat & {
  firstMessageId: string;
  messageId?: string;
  attempted?: boolean;
};
const hex = /^[0-9a-f]{64}$/;
export function readLinkedChat(
  scope: string,
  key: string,
): LinkedChat | undefined {
  const value = readView<Partial<LinkedChat> | null>(scope, key, null);
  if (
    !value ||
    typeof value.link !== "string" ||
    typeof value.channelId !== "string" ||
    typeof value.share !== "boolean"
  )
    return;
  const target = parseBuzzLink(value.link);
  if (
    target?.format !== "legacy" ||
    target.channelId !== value.channelId ||
    value.threadRootId !== (target.threadRootId ?? target.messageId)
  )
    return;
  return value as LinkedChat;
}
export function readShareBack(
  scope: string,
  id: string,
): ShareBack | undefined {
  const key = shareBackKey(id);
  if (!readLinkedChat(scope, key)) return;
  const value = readView<Partial<ShareBack>>(scope, key, {});
  if (
    !value.share ||
    typeof value.firstMessageId !== "string" ||
    !hex.test(value.firstMessageId) ||
    (value.messageId !== undefined && !hex.test(value.messageId)) ||
    (value.attempted !== undefined && typeof value.attempted !== "boolean")
  )
    return;
  return value as ShareBack;
}
export const linkedDraftKey = (id: string) => `solo:linked:${id}`;
export const shareBackKey = (id: string) => `solo:share-back:${id}`;
