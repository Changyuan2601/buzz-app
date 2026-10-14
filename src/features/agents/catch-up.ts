// Saved catch-up progress for event watches of kind 9 only, as Janet keeps it:
// one stream for each watch and channel. Each window of missed events is read
// whole, newest page first, within a bound, and then delivered oldest first.
// Only the progress is saved, never an event.
import type { Agent } from "./service";
import type { EventData, ReadFilter } from "../relay/events";

export const CATCH_UP_KEY = "buzz.agents.catch-up.v1";
/** Events in one read, as Janet's catch-up pages are. */
export const CATCH_UP_PAGE = 16;
/** The most pages one window reads, and its most bytes, as Janet bounds a
 * named channel's window. Past either, the oldest missed events are skipped. */
export const CATCH_UP_PAGES = 256;
export const CATCH_UP_BYTES = 8 * 1024 * 1024;

/** Every kind 9 event of the stream created at or before `through` was
 * delivered or skipped. While a window (`through`, `upper`] is being
 * delivered, `after` is the last event delivered of it, in delivery order:
 * oldest first, ties by id. A restart goes on after it, up to `upper`. */
export type Checkpoint = Readonly<{
  through: number;
  upper?: number;
  after?: Readonly<{ created_at: number; id: string }>;
}>;
export type Checkpoints = Readonly<Record<string, Checkpoint>>;
/** One watch's history in one channel, or in every channel it may read. */
export type Stream = Readonly<{
  key: string;
  slug: string;
  channel?: string;
  since: number;
  enabled: boolean;
}>;
type Position = Pick<EventData, "id" | "created_at">;

const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const ID = /^[0-9a-f]{64}$/;
/** Delivery order: oldest first, ties by id. */
export const oldestFirst = (a: Position, b: Position) =>
  a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function readCheckpoints(storage: Storage): Checkpoints {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(CATCH_UP_KEY) ?? "null");
  } catch {
    return {};
  }
  const streams =
    (stored as { version?: unknown; streams?: unknown } | null)?.version === 1
      ? (stored as { streams: unknown }).streams
      : undefined;
  if (!streams || typeof streams !== "object") return {};
  const checkpoints: Record<string, Checkpoint> = {};
  for (const [key, value] of Object.entries(streams)) {
    const { through, upper, after } = (value ?? {}) as Checkpoint;
    if (
      !time(through) ||
      (upper !== undefined && !(time(upper) && upper > through))
    )
      continue;
    const valid =
      after === undefined ||
      (upper !== undefined &&
        time(after.created_at) &&
        after.created_at > through &&
        after.created_at <= upper &&
        ID.test(after.id));
    if (!valid) continue;
    checkpoints[key] = {
      through,
      ...(upper !== undefined ? { upper } : {}),
      ...(after
        ? { after: { created_at: after.created_at, id: after.id } }
        : {}),
    };
  }
  return checkpoints;
}

export function writeCheckpoints(storage: Storage, checkpoints: Checkpoints) {
  storage.setItem(
    CATCH_UP_KEY,
    JSON.stringify({ version: 1, streams: checkpoints }),
  );
}

/** The agent's streams: one for each channel of each event watch whose kinds
 * are exactly [9], enabled or not. Other kinds have reconnect replay only, as
 * in Janet. */
export function streamsOf(agent: Pick<Agent, "pubkey" | "attention">) {
  const streams: Stream[] = [];
  for (const { slug, value } of Object.values(agent.attention)) {
    if (value.type !== "event") continue;
    if (value.kinds.length !== 1 || value.kinds[0] !== 9) continue;
    for (const channel of value.channels === "all"
      ? [undefined]
      : value.channels)
      streams.push({
        key: JSON.stringify([agent.pubkey, slug, channel ?? null]),
        slug,
        ...(channel ? { channel } : {}),
        since: value.since,
        enabled: value.enabled,
      });
  }
  return streams;
}

/** A stream's missed events to deliver, oldest first, and the checkpoint
 * that says what of its window is already done. */
export type Window<Event extends Position> = Readonly<{
  events: readonly Event[];
  /** The window's upper bound. */
  upper: number;
  /** Delivered or skipped so far; saved before any event is delivered. */
  checkpoint: Checkpoint;
  /** Older missed events were skipped: the window passed its bounds. */
  skipped: boolean;
}>;

/** Reads the stream's missed events through `upper`, or undefined when there
 * are none to read. A window read only in part before goes on after the last
 * event it delivered, up to its own upper bound, which may be older than
 * `upper`. Pages are read newest first; past `CATCH_UP_PAGES` pages or
 * `CATCH_UP_BYTES` bytes the read stops, and the oldest second it reached is
 * skipped with everything older, so no event of a second is left half
 * delivered. Tags are not sent: the relay applies most tag filters after its
 * page limit, so a page could come back empty with older matches left. */
export async function readWindow<Event extends Position>(
  stream: Stream,
  saved: Checkpoint | undefined,
  upper: number,
  read: (filter: ReadFilter) => Promise<readonly Event[]>,
): Promise<Window<Event> | undefined> {
  const checkpoint = saved ?? { through: stream.since - 1 };
  const floor = Math.max(stream.since, checkpoint.through + 1);
  const window = checkpoint.upper ?? upper;
  if (floor > window) return undefined;
  const after = checkpoint.after;
  const pending = (events: Event[]) =>
    events
      .sort(oldestFirst)
      .filter((event) => !after || oldestFirst(event, after) > 0);
  const events: Event[] = [];
  let bytes = 0;
  let cursor: Position | undefined;
  for (let pages = 0; ; pages++) {
    const bounded = pages === CATCH_UP_PAGES || bytes > CATCH_UP_BYTES;
    const filter: ReadFilter = {
      kinds: [9],
      ...(stream.channel ? { "#h": [stream.channel] } : {}),
      since: floor,
      until: cursor?.created_at ?? window,
      ...(cursor ? { before_id: cursor.id } : {}),
      // At its bounds, only whether anything older is left.
      limit: bounded ? 1 : CATCH_UP_PAGE,
    };
    const page = await read(filter);
    if (!page.length) break;
    const last = page.at(-1) as Position;
    // The relay returns the newest first, ties by id ascending; a page that
    // does not move below the cursor is refused, so a bad relay cannot loop.
    const below =
      last.created_at < (filter.until as number) ||
      (last.created_at === filter.until &&
        (filter.before_id === undefined || last.id > filter.before_id));
    if (!below || last.created_at < floor)
      throw new Error("The relay returned a page out of order");
    if (bounded) {
      // The oldest second reached may go on below: it is skipped whole.
      const reached = (cursor as Position).created_at;
      return {
        events: pending(events.filter((event) => event.created_at > reached)),
        upper: window,
        checkpoint: {
          through: Math.max(reached, checkpoint.through),
          upper: window,
          ...(after && after.created_at > reached ? { after } : {}),
        },
        skipped: true,
      };
    }
    for (const event of page) {
      events.push(event);
      bytes += JSON.stringify(event).length;
    }
    cursor = last;
  }
  return {
    events: pending(events),
    upper: window,
    checkpoint: {
      through: checkpoint.through,
      upper: window,
      ...(after ? { after } : {}),
    },
    skipped: false,
  };
}

/** The checkpoint once `last`, the newest event delivered of the window, and
 * every one before it are; or, with no `last`, once all of it is. */
export function delivered(window: number, last?: Position): Checkpoint {
  if (!last) return { through: window };
  return {
    through: last.created_at - 1,
    upper: window,
    after: { created_at: last.created_at, id: last.id },
  };
}
