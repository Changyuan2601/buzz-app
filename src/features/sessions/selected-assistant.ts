import { readView, writeView } from "../../shared/view-state";

const publicKey = /^[0-9a-f]{64}$/;
const key = (channelId: string) => `me:assistant:${channelId}`;

/** Device-local intent, partitioned by the account/community scope and chat. */
export function readSelectedAssistant(scope: string, channelId: string) {
  const value = readView<unknown>(scope, key(channelId), "");
  return typeof value === "string" && publicKey.test(value) ? value : "";
}

export function writeSelectedAssistant(
  scope: string,
  channelId: string,
  pubkey: string,
) {
  return writeView(scope, key(channelId), publicKey.test(pubkey) ? pubkey : "");
}
