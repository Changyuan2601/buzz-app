/** Internal panel target, not an OS deep link or an access grant. */
export type ActivitySelection = Readonly<{
  agent: string;
  channelId?: string;
  /** Exact thread root within channelId; never valid without a channel. */
  threadRootId?: string;
}>;
export function activityTarget(
  agent: string,
  channelId?: string,
  threadRootId?: string,
): string {
  const query = new URLSearchParams({ agent });
  if (channelId) query.set("channel", channelId);
  if (channelId && threadRootId) query.set("thread", threadRootId);
  return `buzz:agent-activity?${query}`;
}
export function activitySelection(
  target: string,
): ActivitySelection | undefined {
  try {
    const url = new URL(target);
    const params = url.searchParams;
    const agent = params.get("agent");
    const channelId = params.get("channel");
    const threadRootId = params.get("thread");
    const key = /^[0-9a-f]{64}$/;
    if (
      url.protocol !== "buzz:" ||
      url.pathname !== "agent-activity" ||
      url.host ||
      url.hash ||
      !agent ||
      !key.test(agent) ||
      params.getAll("agent").length !== 1 ||
      params.getAll("channel").length > 1 ||
      params.getAll("thread").length > 1 ||
      [...params.keys()].some(
        (name) => name !== "agent" && name !== "channel" && name !== "thread",
      ) ||
      (channelId !== null && (!channelId || channelId.length > 256)) ||
      (threadRootId !== null && (channelId === null || !key.test(threadRootId)))
    )
      return;
    return {
      agent,
      ...(channelId !== null ? { channelId } : {}),
      ...(threadRootId !== null ? { threadRootId } : {}),
    };
  } catch {
    return;
  }
}
