import { parseBuzzLink } from "../navigation/buzz-links";
import { readView } from "../../shared/view-state";

/** A local shortcut into ordinary Solo creation, never a parent or access grant. */
export type LinkedChat = {
  channelId: string;
  channelName: string;
  link: string;
  threadRootId?: string;
  share: boolean;
  messageId?: string;
  attempted?: boolean;
};
const token = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
export function readLinkedChat(
  scope: string,
  key: string,
): LinkedChat | undefined {
  const value = readView<Partial<LinkedChat> | null>(scope, key, null);
  if (
    !value ||
    typeof value.channelId !== "string" ||
    !token.test(value.channelId) ||
    typeof value.channelName !== "string" ||
    value.channelName.length > 256 ||
    typeof value.link !== "string" ||
    typeof value.share !== "boolean" ||
    (value.messageId !== undefined &&
      !/^[0-9a-f]{64}$/.test(value.messageId)) ||
    (value.attempted !== undefined && typeof value.attempted !== "boolean") ||
    (value.threadRootId !== undefined &&
      !/^[0-9a-f]{64}$/.test(value.threadRootId))
  )
    return;
  const link = parseBuzzLink(value.link);
  if (
    link?.format !== "legacy" ||
    link.channelId !== value.channelId ||
    value.threadRootId !== (link.threadRootId ?? link.messageId)
  )
    return;
  return value as LinkedChat;
}
export const linkedDraftKey = (id: string) => `solo:linked:${id}`;
export const shareBackKey = (id: string) => `solo:share-back:${id}`;
