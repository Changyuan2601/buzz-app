import type { VirtualizerHandle } from "virtua";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { ChannelQueries } from "../relay/contracts";
import type { TimelineRow } from "./membership-rows";
import { readView, writeView } from "../../shared/view-state";

type Entry = {
  signature: string;
  width: number;
  cache: VirtualizerHandle["cache"];
};
/** Identity/session-scoped and bounded. Event content (not IDs alone) and exact layout width
 * invalidate measurements. Weak ownership releases geometry with the query session. */
const sessions = new WeakMap<ChannelQueries, Map<string, Entry>>();
export function geometryFor(queries: ChannelQueries) {
  const entries = sessions.get(queries) ?? new Map<string, Entry>();
  sessions.set(queries, entries);
  return {
    get(channelId: string, signature: string, width: number) {
      const entry = entries.get(channelId);
      return entry?.signature === signature && entry.width === width
        ? entry.cache
        : undefined;
    },
    set(
      channelId: string,
      signature: string,
      width: number,
      cache: VirtualizerHandle["cache"],
    ) {
      entries.delete(channelId);
      // Signatures include rendered text; bound that memory too, not only view count.
      if (signature.length > 256 * 1024) return;
      entries.set(channelId, { signature, width, cache });
      while (entries.size > 3) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
    },
  };
}
const eventSignatures = new WeakMap<ChannelMessage, string>();
/** One event's content and the labels it renders. */
const eventGeometry = (
  event: ChannelMessage,
  profiles: ReadonlyMap<string, Profile>,
  resolveName?: (id: string, fallback: string) => string,
) => {
  let signature = eventSignatures.get(event);
  if (!signature) {
    signature = JSON.stringify(event);
    eventSignatures.set(event, signature);
  }
  const ids = event.membership
    ? [event.membership.actor, event.membership.target]
    : [
        event.authorId,
        ...(event.workflowOwnerId ? [event.workflowOwnerId] : []),
        ...event.mentions,
        ...(event.mentionReferences ?? []),
      ];
  const names = resolveName
    ? ids.map((id) => resolveName(id, profiles.get(id)?.name ?? id))
    : event.workflowOwnerId
      ? [profiles.get(event.workflowOwnerId)?.name]
      : [];
  return `${JSON.stringify(names)}:${signature.length}:${signature}:${JSON.stringify(event.membership ? [profiles.get(event.membership.actor), profiles.get(event.membership.target)] : profiles.get(event.authorId))}`;
};
export const geometrySignature = (
  events: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  resolveName?: (id: string, fallback: string) => string,
) =>
  events.map((event) => eventGeometry(event, profiles, resolveName)).join("");

/** 53-bit string hash (cyrb53); a collision only costs one re-measured row. */
function hash(text: string) {
  let a = 0xdeadbeef,
    b = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a =
    Math.imul(a ^ (a >>> 16), 2246822507) ^
    Math.imul(b ^ (b >>> 13), 3266489909);
  b =
    Math.imul(b ^ (b >>> 16), 2246822507) ^
    Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}
/**
 * A row's height follows from everything the geometry signature covers for its
 * events, plus its neighbors (day dividers and stacking), its fold and its
 * activity disclosure. Equal keys at an equal layout mean an equal height.
 */
export function rowGeometryKeys(
  rows: readonly TimelineRow[],
  folded: ReadonlySet<string>,
  disclosures: ReadonlyMap<
    string | undefined,
    { ids: readonly string[]; expanded: boolean }
  >,
  profiles: ReadonlyMap<string, Profile>,
  resolveName?: (id: string, fallback: string) => string,
) {
  return rows.map((row, index) => {
    const previous = rows[index - 1],
      next = rows[index + 1],
      disclosure = disclosures.get(row.id);
    return hash(
      JSON.stringify([
        previous?.id,
        previous && folded.has(previous.id),
        next?.id,
        next && folded.has(next.id),
        folded.has(row.id),
        disclosure && [disclosure.ids.length, disclosure.expanded],
      ]) +
        (row.membershipRows ?? [row])
          .map((event) => eventGeometry(event, profiles, resolveName))
          .join(""),
    );
  });
}

type SavedRows = {
  /** Scroller width, text scale and pixel ratio the sizes were measured at. */
  layout: string;
  estimate: number | undefined;
  sizes: Record<string, number>;
};
type ChannelRows = () => SavedRows | undefined;
const ROW_SIZES = "timeline-geometry";
/** Channels kept per scope, and rows kept per channel, newest first. */
const SAVED_CHANNELS = 16,
  SAVED_ROWS = 400;
const scopes = new Map<string, Map<string, SavedRows | ChannelRows>>();
const live = new Set<() => void>();
const unsaved = new Set<string>();
const savedRows = (scope: string) => {
  let channels = scopes.get(scope);
  if (!channels) {
    const stored = readView<unknown>(scope, ROW_SIZES, null);
    channels = new Map(
      stored && typeof stored === "object"
        ? Object.entries(stored as Record<string, SavedRows>)
        : [],
    );
    scopes.set(scope, channels);
  }
  return channels;
};
function persist() {
  for (const run of live) run();
  for (const scope of unsaved) {
    const saved: Record<string, SavedRows> = {};
    for (const [channelId, entry] of savedRows(scope)) {
      const rows = typeof entry === "function" ? entry() : entry;
      if (rows) saved[channelId] = rows;
    }
    writeView(scope, ROW_SIZES, saved);
  }
  unsaved.clear();
}
/**
 * Exact row sizes measured in an earlier visit or session, kept per scope and
 * persisted with its view state when the page hides, as the sidebar's is. A timeline mounting
 * without in-memory geometry seeds Virtua with the size of every row it knows;
 * Virtua still measures each row it mounts.
 */
export const rowSizes = {
  get(
    scope: string,
    channelId: string,
    layout: string,
    keys: () => readonly string[],
  ): VirtualizerHandle["cache"] | undefined {
    const entry = savedRows(scope).get(channelId);
    const saved = typeof entry === "function" ? entry() : entry;
    // Storage is untrusted: anything but a finite size leaves a row estimated.
    if (
      saved?.layout !== layout ||
      typeof saved.sizes !== "object" ||
      !saved.sizes
    )
      return undefined;
    let known = false;
    const sizes = keys().map((key) => {
      const size = Object.hasOwn(saved.sizes, key)
        ? saved.sizes[key]
        : undefined;
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0)
        return -1;
      known = true;
      return size;
    });
    if (!known) return undefined;
    return typeof saved.estimate === "number" &&
      Number.isFinite(saved.estimate) &&
      saved.estimate > 0
      ? [sizes, saved.estimate]
      : [sizes];
  },
  /** Recording is deferred: keys are only built when the sizes are read or saved. */
  set(
    scope: string,
    channelId: string,
    layout: string,
    keys: () => readonly string[],
    cache: VirtualizerHandle["cache"],
  ) {
    let rows: SavedRows | undefined | null = null;
    const channels = savedRows(scope);
    channels.delete(channelId);
    channels.set(channelId, () => {
      if (rows !== null) return rows;
      const sizes: Record<string, number> = {};
      const all = keys();
      let count = 0;
      for (let index = all.length - 1; index >= 0; index--) {
        const size = cache[0][index],
          key = all[index];
        if (key === undefined || size === undefined || size < 0) continue;
        sizes[key] = size;
        if (++count === SAVED_ROWS) break;
      }
      rows = count ? { layout, estimate: cache[1], sizes } : undefined;
      return rows;
    });
    while (channels.size > SAVED_CHANNELS) {
      const first = channels.keys().next().value;
      if (first === undefined) break;
      channels.delete(first);
    }
    unsaved.add(scope);
    listen();
  },
  /** A mounted timeline records itself when the page hides. */
  live(record: () => void) {
    live.add(record);
    listen();
    return () => void live.delete(record);
  },
};
let listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pagehide", persist);
}
