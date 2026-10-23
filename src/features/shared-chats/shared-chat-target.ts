import { buzzLinkTarget } from "../navigation/buzz-links";

/** A scoped presentation request, never an access grant. */
export function sharedChatNavigationTarget(
  channelId: string,
  scope: string,
  viewer: string | undefined,
) {
  if (!viewer) return null;
  const target = buzzLinkTarget(`buzz://channel/${channelId}`, {
    viewer,
    communityOrigin: scope.slice(0, -(viewer.length + 1)),
  });
  return target?.kind === "conversation"
    ? { ...target, panel: "shared-sessions" as const }
    : null;
}
