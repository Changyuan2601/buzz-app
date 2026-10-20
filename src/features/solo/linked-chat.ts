import { parseBuzzLink } from "../navigation/buzz-links";
import { readView } from "../../shared/view-state";

/** One unsent shortcut; the link itself is ordinary editable message content. */
export type LinkedChat = {
  channelId: string;
  link: string;
};
export function readLinkedChat(
  scope: string,
  key: string,
): LinkedChat | undefined {
  const value = readView<Partial<LinkedChat> | null>(scope, key, null);
  if (
    !value ||
    typeof value.link !== "string" ||
    typeof value.channelId !== "string"
  )
    return;
  const target = parseBuzzLink(value.link);
  if (target?.format !== "legacy" || target.channelId !== value.channelId)
    return;
  return value as LinkedChat;
}
export const linkedDraftKey = (id: string) => `solo:linked:${id}`;
