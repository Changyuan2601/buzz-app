/** Ordinary channel metadata describes presentation, never access authority. */
export const SESSION_CHANNEL_DESCRIPTION = "Buzz session (buzz.sessions/v1)";
/** Marks a personal chat: its owner plus their agents, answered as one
 * channel-scoped conversation at top level. Remote agents read it from
 * channel metadata because Me placement is private to the owner. Sharing to
 * Messages replaces the description, which clears it. */
const PERSONAL_LINE = "personal";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sessionDescription(
  parentId?: string,
  personal = false,
): string {
  return [
    SESSION_CHANNEL_DESCRIPTION,
    ...(parentId ? [`parent:${parentId}`] : []),
    ...(personal ? [PERSONAL_LINE] : []),
  ].join("\n");
}
export function sessionMetadata(
  description: string | undefined,
): { parentId?: string; personal?: true } | undefined {
  const [header, ...lines] = description?.split("\n") ?? [];
  if (header !== SESSION_CHANNEL_DESCRIPTION) return;
  const parent = lines[0]?.startsWith("parent:")
    ? lines.shift()?.slice("parent:".length)
    : undefined;
  if (parent !== undefined && !uuid.test(parent)) return;
  const personal = lines[0] === PERSONAL_LINE && !!lines.shift();
  if (lines.length) return;
  return {
    ...(parent ? { parentId: parent } : {}),
    ...(personal ? { personal: true as const } : {}),
  };
}
