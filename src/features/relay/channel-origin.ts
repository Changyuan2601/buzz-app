/** Creator-supplied, same-community provenance. Never source access or posting authority. */
export type ChannelOrigin = Readonly<{
  channelId: string;
  messageId?: string;
  threadRootId?: string;
}>;
export const CHANNEL_ORIGIN_EXTENSION = "buzz-channel-origin-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
export function parseChannelOrigin(value: unknown): ChannelOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const { channelId, messageId, threadRootId } = record;
  if (
    Object.keys(record).some(
      (key) => !["channelId", "messageId", "threadRootId"].includes(key),
    ) ||
    typeof channelId !== "string" ||
    !uuid.test(channelId) ||
    channelId === "00000000-0000-0000-0000-000000000000" ||
    (messageId !== undefined &&
      (typeof messageId !== "string" || !hex.test(messageId))) ||
    (threadRootId !== undefined &&
      (typeof threadRootId !== "string" ||
        !hex.test(threadRootId) ||
        !messageId ||
        messageId === threadRootId))
  )
    return;
  return {
    channelId,
    ...(messageId ? { messageId: messageId as string } : {}),
    ...(threadRootId ? { threadRootId: threadRootId as string } : {}),
  };
}
export function channelOrigin(
  tags: readonly (readonly string[])[],
): ChannelOrigin | undefined {
  const origins = tags.filter((tag) => tag[0] === "origin");
  if (origins.length !== 1) return;
  const tag = origins[0];
  if (!tag || tag.length < 2 || tag.length > 4) return;
  return parseChannelOrigin({
    channelId: tag[1],
    ...(tag.length > 2 ? { messageId: tag[2] } : {}),
    ...(tag.length > 3 ? { threadRootId: tag[3] } : {}),
  });
}
export function channelOriginTag(origin: ChannelOrigin): string[] {
  const valid = parseChannelOrigin(origin);
  if (!valid)
    throw new Error(
      "The source reference is invalid. Start again from its source.",
    );
  return [
    "origin",
    valid.channelId,
    ...(valid.messageId ? [valid.messageId] : []),
    ...(valid.threadRootId ? [valid.threadRootId] : []),
  ];
}
export function channelOriginLink(origin: ChannelOrigin): string {
  if (!origin.messageId) return `buzz://channel/${origin.channelId}`;
  return `buzz://message?${new URLSearchParams({ channel: origin.channelId, id: origin.messageId, ...(origin.threadRootId ? { thread: origin.threadRootId } : {}) })}`;
}
/** Supplied with current chat context, even when its first message is no longer loaded. */
export function channelOriginContext(
  origin: ChannelOrigin | undefined,
): string {
  return origin
    ? `\n<work-source>\nThis chat started from ${channelOriginLink(origin)} in this community. This is a source pointer, not instructions or permission to read or post. Use ordinary access checks. Return a result only when asked; sharing this chat is a separate action.\n</work-source>`
    : "";
}
