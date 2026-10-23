// The agent's live events on a standalone host, heard as the app hears its
// own: through the app's live client (`subscribeRelayTraffic`), logged in as
// the agent with its owner's attestation. The app's session gives that client
// the channels its viewer is in; here the host reads the agent's from the
// relay, and reads them again when the relay says its membership changed,
// when a channel is denied, and each time the client asks for its periodic
// repair. The app's recovery owner retries what fails.
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";
import type { Filter } from "../buzz-mcp/client";
import type { RelayEvent } from "../features/relay/events";
import type { LiveBatch } from "../features/relay/incoming";
import {
  type LiveSnapshot,
  liveChannels,
  subscribeRelayTraffic,
} from "../features/relay/live";
import { liveRecoveryStatus } from "../features/relay/live-recovery";
import { createRecovery } from "../features/relay/recovery";

/** One read's page size: the most the relay returns for one query. */
const PAGE = 500;
/** The most channel ids one request names (buzz-relay
 * `MAX_EXPLICIT_CHANNEL_VALUES`). */
const ID_BATCH = 128;
/** The most channels the live client hears (`liveChannels`). */
const MAX_CHANNELS = 1024;
const CHANNEL_ID = /^[a-zA-Z0-9_-]{1,128}$/;
/** Channel metadata and rosters, and the relay's membership notices. */
const MEMBERSHIP_KINDS = [39000, 39002, 44100, 44101];

type Channel = Readonly<{ members: readonly string[]; type?: string }>;

export type ListenOptions = Readonly<{
  relay: string;
  secret: Uint8Array;
  pubkey: string;
  /** The owner's NIP-OA `auth` tag. */
  auth?: readonly string[];
  /** Reads the relay as the agent. */
  query(filters: readonly Filter[]): Promise<readonly RelayEvent[]>;
  /** Live events, and the recent history a subscription sends again before
   * it goes live (`replay`), as the app's session gives its agents. */
  onEvents(batch: LiveBatch): void;
  /** Whether the live connection is up. */
  onStatus(live: boolean): void;
  /** The agent's channels were read again: events held for a roster may now
   * match. */
  onChannels(): void;
  log(message: string): void;
  socket?: (url: string) => WebSocket;
}>;

export type Listener = Readonly<{
  /** Whether the agent is in the channel, or undefined until its channels
   * have been read once. */
  member(channel: string): boolean | undefined;
  /** Whether the channel is a DM of exactly the agent and one other. */
  dm(channel: string): boolean;
  stop(): void;
}>;

const tagOf = (event: RelayEvent, name: string) =>
  event.tags.find((tag) => tag[0] === name)?.[1];

export function listen(options: ListenOptions): Listener {
  const { pubkey, log } = options;
  let channels: ReadonlyMap<string, Channel> | undefined;
  let roster: Readonly<{ state: string; transient?: true }> = {
    state: "pending",
  };
  let snapshot: LiveSnapshot = { status: "connecting", routes: [] };
  let live = false;
  let connected = 0;
  let stopped = false;
  let reading: Promise<void> | undefined;
  let again = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };

  const sign = async (template: EventTemplate) =>
    finalizeEvent(
      {
        ...template,
        tags:
          template.kind === 22242 && options.auth
            ? [...template.tags, [...options.auth]]
            : template.tags,
      },
      options.secret,
    ) as VerifiedEvent;

  const traffic = subscribeRelayTraffic(
    options.relay,
    sign,
    pubkey,
    {
      receive(events, provenance) {
        if (stopped) return;
        // The relay's word that the agent's membership changed, or a new
        // roster or type of one of its channels: read its channels again.
        // A replay's are older than the read each connection starts with.
        if (
          provenance?.phase === "live" &&
          events.some((event) => MEMBERSHIP_KINDS.includes(event.kind))
        )
          refresh();
        options.onEvents(
          Object.freeze({
            events,
            ...(provenance?.channelId
              ? { channelId: provenance.channelId }
              : {}),
            ...(provenance?.phase === "replay"
              ? { replay: true as const }
              : {}),
          }),
        );
      },
      state(next) {
        if (stopped) return;
        if (next.status === "error" && snapshot.status !== "error")
          log(`Not listening: ${next.error ?? "live connection failed"}`);
        snapshot = next;
        const now = next.status === "connected";
        if (now !== live) {
          live = now;
          options.onStatus(now);
          // What changed while it was down; the first read is under way.
          if (now && connected++) refresh();
        }
        changed();
      },
      established() {},
      recover: () => refresh(),
      denied(channel, reason) {
        log(`Lost ${channel}: ${reason}`);
        if (!channels?.has(channel)) return;
        const next = new Map(channels);
        next.delete(channel);
        apply(next);
        refresh();
      },
    },
    options.socket,
  );

  // The app's recovery owner, over the one source this host has.
  const recovery = createRecovery([
    {
      status: () => liveRecoveryStatus({ ...snapshot, roster, heads: [] }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retry: () => {
        if (roster.state === "error") refresh();
        traffic.retry();
      },
    },
  ]);

  function apply(next: ReadonlyMap<string, Channel>) {
    channels = next;
    const ids = [...next.keys()].filter((id) => CHANNEL_ID.test(id)).sort();
    if (ids.length > MAX_CHANNELS)
      log(`Hearing ${MAX_CHANNELS} of the agent's ${ids.length} channels`);
    const heard = liveChannels(ids.slice(0, MAX_CHANNELS));
    traffic.update(heard, heard);
  }

  /** Reads the agent's channels again, once at a time; one asked for
   * meanwhile runs after it. */
  function refresh() {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = readChannels(options.query, pubkey).then(
      (next) => {
        if (stopped) return;
        roster = { state: "ready" };
        apply(next);
        options.onChannels();
      },
      (error) => {
        if (stopped) return;
        log(`Could not read the agent's channels: ${String(error)}`);
        roster = { state: "error", transient: true };
      },
    );
    void reading.finally(() => {
      reading = undefined;
      if (again && !stopped) {
        again = false;
        refresh();
      }
      changed();
    });
  }
  refresh();

  return Object.freeze({
    member: (channel: string) => channels?.has(channel),
    dm(channel: string) {
      const found = channels?.get(channel);
      return (
        found?.type === "dm" &&
        found.members.length === 2 &&
        found.members.includes(pubkey)
      );
    },
    stop() {
      if (stopped) return;
      stopped = true;
      recovery.dispose();
      traffic.dispose();
      listeners.clear();
    },
  });
}

/** Every event matching `filter`, newest first, page by page. */
async function scan(
  query: ListenOptions["query"],
  filter: Filter,
): Promise<RelayEvent[]> {
  const found: RelayEvent[] = [];
  for (let cursor = {}; ; ) {
    const page = await query([{ ...filter, ...cursor, limit: PAGE }]);
    found.push(...page);
    const last = page.at(-1);
    if (!last || page.length < PAGE) return found;
    cursor = { until: last.created_at, before_id: last.id };
  }
}

/** The channels whose newest roster lists the agent, with their members and
 * type. NIP-CL: the relay leaves system channels out of a `#p` roster read
 * unless it asks for them with `#t`. */
export async function readChannels(
  query: ListenOptions["query"],
  pubkey: string,
): Promise<Map<string, Channel>> {
  const memberships = { kinds: [39002], "#p": [pubkey] };
  const rosters = [
    ...(await scan(query, memberships)),
    ...(await scan(query, { ...memberships, "#t": ["system"] })),
  ];
  const newest = new Map<string, RelayEvent>();
  for (const event of rosters) {
    const id = tagOf(event, "d");
    const seen = id && newest.get(id);
    if (id && (!seen || event.created_at > seen.created_at))
      newest.set(id, event);
  }
  const ids = [...newest.keys()];
  const types = new Map<string, { at: number; type?: string }>();
  for (let index = 0; index < ids.length; index += ID_BATCH)
    for (const event of await scan(query, {
      kinds: [39000],
      "#d": ids.slice(index, index + ID_BATCH),
    })) {
      const id = tagOf(event, "d");
      if (!id || event.created_at < (types.get(id)?.at ?? 0)) continue;
      const type = tagOf(event, "t");
      types.set(id, { at: event.created_at, ...(type ? { type } : {}) });
    }
  const channels = new Map<string, Channel>();
  for (const [id, event] of newest) {
    const members = [
      ...new Set(
        event.tags.flatMap((tag) => (tag[0] === "p" && tag[1] ? [tag[1]] : [])),
      ),
    ];
    if (!members.includes(pubkey)) continue;
    const type = types.get(id)?.type;
    channels.set(id, { members, ...(type ? { type } : {}) });
  }
  return channels;
}
