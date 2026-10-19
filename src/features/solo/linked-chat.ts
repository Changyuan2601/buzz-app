import {
  parseChannelOrigin,
  type ChannelOrigin,
} from "../relay/channel-origin";
import { readView } from "../../shared/view-state";
/** Before creation only; the relay's chat metadata owns origin afterward. */
export function readLinkedChat(
  scope: string,
  key: string,
): ChannelOrigin | undefined {
  return parseChannelOrigin(readView<unknown>(scope, key, null));
}
export const linkedDraftKey = (id: string) => `solo:linked:${id}`;
