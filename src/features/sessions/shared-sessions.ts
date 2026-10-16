import type { BuzzEvent, Filter } from "../../buzz-mcp/client";
import { channelIdentity } from "../relay/channel-labels";
import {
  metadataName,
  openMetadata,
  sessionChannelMetadata,
} from "../relay/discovery";
import { ReadError, readErrorKind } from "../relay/errors";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { foldMessages } from "../relay/fold";
import type { RelaySession } from "../relay/session";
import { sessionLinkMessage } from "./share";
import { SESSION_NAMED_LABEL } from "./metadata";
import { sharedSessionIds } from "./shared-session-marker";

export type SharedSessionCursor = Readonly<{
  until: number;
  before_id: string;
}>;
export type SharedSessionEntry = Readonly<{
  id: string;
  title: string;
  shares: readonly { id: string; pubkey: string; createdAt: number }[];
  sharedAt: number;
}>;
export type SharedSessionPage = Readonly<{
  entries: readonly SharedSessionEntry[];
  cursor?: SharedSessionCursor;
  complete: boolean;
  errors: readonly string[];
  scanned?: number;
}>;
type Reader = {
  pubkey: string;
  query(filters: readonly Filter[]): Promise<readonly Omit<BuzzEvent, "sig">[]>;
  relayAuthor?: string | undefined;
  signingAuthority?: string | undefined;
  authorizeAudience?(
    destination: string,
    sources: readonly string[],
  ): Promise<ReadonlySet<string>>;
};
type Options = {
  cursor?: SharedSessionCursor | undefined;
  limit?: number | undefined;
  query?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Set only by the host-bound agent tool, never by a model-selected argument. */
  audience?: string | undefined;
  shareIds?: readonly string[] | undefined;
};
const compare = (
  a: { created_at: number; id: string },
  b: { created_at: number; id: string },
) => b.created_at - a.created_at || a.id.localeCompare(b.id);
const channelId = (value: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
const unavailable = () =>
  new Error("Shared session access could not be confirmed. Retry.");

function readerFor(value: Reader | RelaySession, signal?: AbortSignal): Reader {
  if ("query" in value) return value;
  return {
    pubkey: value.viewer ?? "",
    relayAuthor: value.relayAuthor,
    signingAuthority: value.workflowAuthority,
    query: async (filters) => {
      return value.readRemote(filters as readonly ReadFilter[], {
        fresh: true,
        ...(signal ? { signal } : {}),
      });
    },
  };
}

/** No retained transcript/title cache: the owning view controls lifecycle and aborts. */
function accessReader(value: Reader | RelaySession, options: Options) {
  const reader = readerFor(value, options.signal);
  if (!reader.pubkey || !reader.relayAuthor) throw unavailable();
  const query = async (filter: ReadFilter) => {
    options.signal?.throwIfAborted();
    let events: readonly Omit<BuzzEvent, "sig">[];
    try {
      events = await reader.query([{ ...filter, consistency: "strong" }]);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new ReadError(
        readErrorKind(error),
        "Shared session data could not be loaded. Retry.",
      );
    }
    options.signal?.throwIfAborted();
    // Both adapters admit verified events. Copy readonly wire tags for the shared fold.
    return events.map((event) => ({
      ...event,
      tags: event.tags.map((tag) => [...tag]),
    })) as RelayEvent[];
  };
  return { reader, query, relayAuthor: reader.relayAuthor };
}
type AccessReader = ReturnType<typeof accessReader>;

async function access(io: AccessReader, id: string) {
  if (!channelId(id)) throw unavailable();
  let records: RelayEvent[];
  try {
    records = await io.query({
      kinds: [39000, 39002],
      authors: [io.relayAuthor],
      "#d": [id],
      limit: 2,
    });
  } catch (error) {
    if (readErrorKind(error) === "denied") return undefined;
    throw error;
  }
  return accessRecord(io, id, records);
}

function accessRecord(
  io: AccessReader,
  id: string,
  records: readonly RelayEvent[],
) {
  const exact = records.filter(
    (event) =>
      event.pubkey === io.reader.relayAuthor &&
      event.tags.filter(([key]) => key === "d").length === 1 &&
      event.tags.some(([key, value]) => key === "d" && value === id),
  );
  if (
    [39000, 39002].some(
      (kind) => exact.filter((event) => event.kind === kind).length > 1,
    )
  )
    throw unavailable();
  const metadata = exact.find((event) => event.kind === 39000);
  const roster = exact.find((event) => event.kind === 39002);
  if (!metadata) return undefined;
  if (!roster) throw unavailable();
  const members = roster.tags
    .filter(([key]) => key === "p")
    .map((tag) => tag[1] ?? "");
  if (members.some((key) => !/^[0-9a-f]{64}$/.test(key))) throw unavailable();
  if (!members.includes(io.reader.pubkey) && !openMetadata(metadata))
    return undefined;
  return { metadata, members, roster };
}
async function accessSnapshot(io: AccessReader, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length > 500 || unique.some((id) => !channelId(id)))
    throw unavailable();
  // One filter is one authoritative SQL snapshot. Separate filters/awaits are not.
  return io.query({
    kinds: [39000, 39002],
    authors: [io.relayAuthor],
    "#d": unique,
    limit: unique.length * 2,
  });
}

async function authorizeAudience(
  io: AccessReader,
  destination: string,
  sources: readonly string[],
  signal?: AbortSignal,
) {
  if (!io.reader.authorizeAudience)
    throw new Error(
      "This community cannot confirm the current answer audience. Shared-session agent retrieval requires updated server support.",
    );
  signal?.throwIfAborted();
  const allowed = await io.reader.authorizeAudience(destination, sources);
  signal?.throwIfAborted();
  return allowed;
}

async function page(
  io: AccessReader,
  filter: ReadFilter,
  cursor?: SharedSessionCursor,
) {
  const events = await io.query({ ...filter, ...cursor });
  // Never quietly accept an ignored topic filter/cursor or auxiliary rows as base rows.
  if (
    events.length > filter.limit ||
    new Set(events.map((event) => event.id)).size !== events.length ||
    events.some(
      (event) =>
        !filter.kinds?.includes(event.kind) ||
        Object.entries(filter).some(
          ([key, values]) =>
            key.startsWith("#") &&
            Array.isArray(values) &&
            !event.tags.some(
              ([tag, value]) => tag === key.slice(1) && values.includes(value),
            ),
        ) ||
        (cursor &&
          (event.created_at > cursor.until ||
            (event.created_at === cursor.until &&
              event.id <= cursor.before_id))),
    )
  )
    throw new Error(
      "Shared session paging is unsupported or inconsistent. Retry.",
    );
  events.sort(compare);
  const last = events.at(-1);
  return {
    events,
    cursor:
      events.length === filter.limit && last
        ? { until: last.created_at, before_id: last.id }
        : undefined,
  };
}

/** Fetch complete bounded edit/delete closure, including deletion of an edit. */
async function currentMessages(
  io: AccessReader,
  destination: string,
  base: readonly RelayEvent[],
) {
  const overlays: RelayEvent[] = [];
  const collect = async (ids: string[], kinds: number[]) => {
    if (!ids.length) return;
    let cursor: SharedSessionCursor | undefined;
    do {
      const next = await page(io, { kinds, "#e": ids, limit: 500 }, cursor);
      overlays.push(...next.events);
      if (overlays.length > 2000)
        throw new Error(
          "Shared session edits exceed the read budget. Retry with a smaller page.",
        );
      cursor = next.cursor;
    } while (cursor);
  };
  await collect(
    base.map((event) => event.id),
    [40003, 5, 9005],
  );
  await collect(
    overlays.filter((event) => event.kind === 40003).map((event) => event.id),
    [5, 9005],
  );
  return foldMessages(destination, io.relayAuthor, [...base, ...overlays], {
    includeReplies: true,
    signingAuthority: io.reader.signingAuthority,
  });
}

/** One page of confirmed share messages. Merge pages by source ID and share event ID. */
export async function listSharedSessions(
  value: Reader | RelaySession,
  destination: string,
  options: Options = {},
): Promise<SharedSessionPage> {
  const io = accessReader(value, options);
  const initialDestination = await access(io, destination);
  if (!initialDestination) throw unavailable();
  if (options.audience && options.audience !== destination) throw unavailable();
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  const groups = new Map<string, SharedSessionEntry["shares"][number][]>();
  let cursor = options.cursor;
  let scanned = 0;
  do {
    const result = await page(
      io,
      { kinds: [9], "#h": [destination], limit: 50 },
      cursor,
    );
    const rows = await currentMessages(io, destination, result.events);
    let consumed = 0;
    for (const original of result.events) {
      const row = rows.find((item) => item.id === original.id);
      if (row)
        for (const id of sharedSessionIds(original, row.content)) {
          const shares = groups.get(id) ?? [];
          shares.push({
            id: row.id,
            pubkey: row.authorId,
            createdAt: row.createdAt,
          });
          groups.set(id, shares);
        }
      consumed++;
      scanned++;
      cursor = { until: original.created_at, before_id: original.id };
      if (groups.size >= limit || scanned >= 1000) break;
    }
    if (consumed === result.events.length) cursor = result.cursor;
    if (!cursor || groups.size >= limit) break;
  } while (scanned < 1000);
  const errors = new Set<string>();
  // Topic filters are applied after LIMIT by the relay: page channel messages,
  // filter markers locally, and preserve the raw page cursor even for empty results.
  let records: RelayEvent[];
  try {
    records = await accessSnapshot(io, [destination, ...groups.keys()]);
  } catch {
    options.signal?.throwIfAborted();
    return {
      scanned,
      entries: [],
      ...(cursor ? { cursor } : {}),
      complete: false,
      errors: ["Some shared sessions could not be loaded. Retry."],
    };
  }
  const finalDestination = accessRecord(io, destination, records);
  if (!finalDestination) throw unavailable();
  const checked: SharedSessionEntry[] = [];
  for (const [id, shares] of groups) {
    try {
      const source = accessRecord(io, id, records);
      if (!source || !sessionChannelMetadata(source.metadata)) continue;
      const title = metadataName(source.metadata)?.trim() || id.slice(0, 8);
      if (
        options.query &&
        !title.toLocaleLowerCase().includes(options.query.toLocaleLowerCase())
      )
        continue;
      shares.sort(
        (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
      );
      const latest = shares[0];
      if (latest)
        checked.push({ id, title, shares, sharedAt: latest.createdAt });
    } catch {
      errors.add("Some shared sessions could not be loaded. Retry.");
    }
  }
  // Ineligible historical links must not poison the strict authority request.
  const allowed =
    options.audience && checked.length
      ? await authorizeAudience(
          io,
          destination,
          checked.map(({ id }) => id),
          options.signal,
        )
      : undefined;
  // Release only after the current decision, without another asynchronous read.
  options.signal?.throwIfAborted();
  checked.sort((a, b) => b.sharedAt - a.sharedAt || a.id.localeCompare(b.id));
  return {
    scanned,
    entries: allowed ? checked.filter(({ id }) => allowed.has(id)) : checked,
    ...(cursor ? { cursor } : {}),
    complete: !cursor && !errors.size,
    errors: [...errors],
  };
}

/** Read only a surviving shared association, for the host-bound answer audience. */
export async function readSharedSession(
  value: Reader,
  destination: string,
  sourceId: string,
  options: Options = {},
) {
  const io = accessReader(value, options);
  if (!channelId(sourceId)) throw unavailable();
  const dest = await access(io, destination);
  if (!dest) throw unavailable();
  let cursor: SharedSessionCursor | undefined;
  let found: RelayEvent | undefined;
  if (options.shareIds) {
    if (
      !options.shareIds.length ||
      options.shareIds.length > 32 ||
      options.shareIds.some((id) => !/^[0-9a-f]{64}$/.test(id))
    )
      throw unavailable();
    const receipts = await io.query({
      kinds: [9],
      ids: [...new Set(options.shareIds)],
      "#h": [destination],
      limit: options.shareIds.length,
    });
    const exact = receipts.filter(
      (e) =>
        options.shareIds?.includes(e.id) &&
        e.kind === 9 &&
        e.tags.some(([k, v]) => k === "h" && v === destination),
    );
    const rows = await currentMessages(io, destination, exact);
    found = exact.find((e) =>
      rows.some(
        (row) =>
          row.id === e.id &&
          sharedSessionIds(e, row.content).includes(sourceId),
      ),
    );
  }
  for (
    let scanned = 0;
    !options.shareIds && scanned < 1000 && !found;
    scanned += 50
  ) {
    const result = await page(
      io,
      {
        kinds: [9],
        "#h": [destination],
        limit: 50,
      },
      cursor,
    );
    const rows = await currentMessages(io, destination, result.events);
    for (const row of rows) {
      const original = result.events.find((event) => event.id === row.id);
      if (
        original &&
        sharedSessionIds(original, row.content).includes(sourceId)
      ) {
        found = original;
        break;
      }
    }
    cursor = result.cursor;
    if (!cursor) break;
  }
  if (!found)
    throw new Error(
      "No current shared session association was confirmed within the read budget.",
    );
  const source = await access(io, sourceId);
  if (!source || !sessionChannelMetadata(source.metadata)) throw unavailable();
  const result = await page(
    io,
    {
      kinds: [9, 40002, 40008],
      "#h": [sourceId],
      limit: Math.max(1, Math.min(50, options.limit ?? 20)),
    },
    options.cursor,
  );
  const messages = await currentMessages(io, sourceId, result.events);
  const surviving = await io.query({ kinds: [9], ids: [found.id], limit: 1 });
  const currentShares = await currentMessages(io, destination, surviving);
  if (
    !currentShares.some((row) =>
      sharedSessionIds(found, row.content).includes(sourceId),
    )
  )
    throw new Error(
      "The shared session association changed during retrieval. Retry.",
    );
  const records = await accessSnapshot(io, [destination, sourceId]);
  const afterSource = accessRecord(io, sourceId, records);
  const afterDestination = accessRecord(io, destination, records);
  if (
    !afterSource ||
    !afterDestination ||
    !sessionChannelMetadata(afterSource.metadata)
  )
    throw unavailable();
  const allowed = await authorizeAudience(
    io,
    destination,
    [sourceId],
    options.signal,
  );
  if (!allowed.has(sourceId))
    throw new Error(
      "Shared session access could not be confirmed for the current answer audience.",
    );
  const name = channelIdentity(afterSource.metadata).labels.includes(
    SESSION_NAMED_LABEL,
  )
    ? metadataName(afterSource.metadata)
    : undefined;
  const contentLimit = Math.min(
    8192,
    Math.floor(32768 / Math.max(1, messages.length)),
  );
  return {
    id: sourceId,
    citation: sessionLinkMessage(sourceId, name),
    messages: messages.map((row) => ({
      id: row.id,
      author: row.authorId,
      createdAt: row.createdAt,
      content: row.content.slice(0, contentLimit),
      ...(row.content.length > contentLimit ? { truncated: true } : {}),
    })),
    ...(result.cursor ? { cursor: result.cursor } : {}),
    complete:
      !result.cursor &&
      messages.every((row) => row.content.length <= contentLimit),
  };
}
