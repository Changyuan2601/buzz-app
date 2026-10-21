import {
  entityTarget,
  parseEntityLink,
  type EntityRoute,
} from "../repos/routes";
import { communityDestination } from "../communities/destination";
import { parseOpenTarget, type NavigationScope } from "./targets";

type Destination = {
  channelId: string;
  messageId?: string;
  threadRootId?: string;
};
type BuzzLink =
  | { format: "removed" }
  | { format: "entity"; route: EntityRoute }
  | ({ format: "legacy" } & Destination)
  // Names its community, so it is never looked up in the receiving one.
  | ({ format: "scoped"; communityId: string } & Destination);

/** A `community-id` query names the destination's community. A repeated or
 * invalid one is ambiguous and rejects the link. */
function inCommunity(url: URL, destination: Destination): BuzzLink {
  const ids = url.searchParams.getAll("community-id");
  if (ids.length > 1) throw new Error("Ambiguous community");
  const [id] = ids;
  return id === undefined
    ? { format: "legacy", ...destination }
    : {
        format: "scoped",
        communityId: communityDestination(id).id,
        ...destination,
      };
}

/** True for any `buzz:` scheme link, regardless of case. Classification must
 * match `parseBuzzLink`, which normalizes the scheme via `URL`; a lowercase-only
 * `startsWith` check would misroute `BUZZ://…` to external handling. */
export function isBuzzLink(href: string): boolean {
  try {
    return new URL(href).protocol === "buzz:";
  } catch {
    return false;
  }
}

/** Legacy links are relative to the receiving conversation's community, and
 * scoped ones name theirs; neither is an access grant. */
export function parseBuzzLink(href: string): BuzzLink | null {
  try {
    if (href.length > 32768) return null;
    const url = new URL(href);
    if (
      url.protocol !== "buzz:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    if (
      url.hostname === "project" &&
      (url.pathname === "" || url.pathname === "/")
    )
      return { format: "removed" };
    const entity = parseEntityLink(url);
    if (entity) return { format: "entity", route: entity };
    const channelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
    const eventPattern = /^[a-f0-9]{64}$/i;
    // Query parameters outside a form's grammar are ignored, values and repeats
    // included, as the original Buzz desktop client does. The channel forms carry
    // everything else in the path, so only `community-id` is read there.
    if (url.hostname === "channel") {
      const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
      const [channelId = "", messageId] = parts;
      if (
        parts.length > 2 ||
        !channelPattern.test(channelId) ||
        (messageId !== undefined && !eventPattern.test(messageId))
      )
        return null;
      return inCommunity(url, {
        channelId,
        ...(messageId ? { messageId: messageId.toLowerCase() } : {}),
      });
    }
    // Windows can supply an explicit root path before the query. Check its raw
    // form too: URL normalizes non-root paths such as /extra/.. to /.
    if (
      url.hostname !== "message" ||
      (url.pathname !== "" &&
        (url.pathname !== "/" || !/^buzz:\/\/message\/\?/i.test(href)))
    )
      return null;
    // A duplicated known key is ambiguous and still rejects.
    if (
      ["channel", "id", "thread"].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    )
      return null;
    const channelId = url.searchParams.get("channel") ?? "";
    const messageId = url.searchParams.get("id") ?? "";
    const threadRootId = url.searchParams.get("thread");
    if (
      !channelPattern.test(channelId) ||
      !eventPattern.test(messageId) ||
      (threadRootId !== null && !eventPattern.test(threadRootId))
    )
      return null;
    return inCommunity(url, {
      channelId,
      messageId: messageId.toLowerCase(),
      ...(threadRootId ? { threadRootId: threadRootId.toLowerCase() } : {}),
    });
  } catch {
    return null;
  }
}

export function buzzLinkKind(href: string) {
  const link = parseBuzzLink(href);
  if (!link) return null;
  if (link.format === "entity" || link.format === "removed") return "buzz";
  return link.threadRootId ? "thread" : link.messageId ? "message" : "channel";
}

export function buzzLinkTarget(href: string, scope: NavigationScope) {
  const link = parseBuzzLink(href);
  if (!link) return null;
  if (link.format === "entity") return entityTarget(link.route, scope);
  if (link.format === "removed")
    return {
      version: 1,
      kind: "page",
      pluginId: "buzz.repos",
      pageId: "repos",
      scope,
    } as const;
  if (link.format === "scoped") {
    const { format: _format, communityId, ...destination } = link;
    return parseOpenTarget({
      version: 1,
      kind: "conversation",
      scope: {
        viewer: scope.viewer,
        communityOrigin: communityDestination(communityId).url,
      },
      ...destination,
    });
  }
  const { format: _format, ...destination } = link;
  return parseOpenTarget({
    version: 1,
    kind: "conversation",
    scope,
    ...destination,
  });
}
