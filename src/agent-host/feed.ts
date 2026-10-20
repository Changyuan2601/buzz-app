// The agent's live feed on a standalone host: one WebSocket to its community,
// logged in as the agent (NIP-42, carrying its owner's attestation), that
// hears what names the agent and everything in the channels it is in. It
// reconnects after a drop, and each subscription picks up from where it
// stopped hearing.
import { finalizeEvent } from "nostr-tools/pure";
import { CHAT_KINDS } from "../features/agents/attention";
import { eventsDto, type RelayEvent } from "../features/relay/events";
import type { LiveBatch } from "../features/relay/incoming";

const KINDS = [...new Set([...CHAT_KINDS, 4, 5, 7, 40002])];
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Catch-up after a drop reaches back this far before the last event heard. */
const OVERLAP_S = 30;
/** The most channels one request names: the relay refuses more
 * (buzz-relay `MAX_EXPLICIT_CHANNEL_VALUES`), so channels are heard in
 * batches of this many, each its own subscription. */
export const CHANNEL_BATCH = 128;
/** The most events held for one channel while its metadata loads, and
 * while the feed is not live. */
const HELD_LIMIT = 500;
/** Why a relay closes a subscription that asking again will not change: it
 * stays closed until the next connection. Other closes are tried again. */
const DENIED = /^(restricted|blocked):/;

export type FeedOptions = Readonly<{
  relay: string;
  secret: Uint8Array;
  pubkey: string;
  /** The owner's NIP-OA `auth` tag. */
  auth?: readonly string[];
  /** Live events, one batch per event, with the event's channel. Only while
   * the feed is live: ones heard meanwhile come once it is live again. Those,
   * and what a request sends before its EOSE, come as a replay, which the
   * runner takes as it has room. */
  onEvents(batch: LiveBatch): void;
  /** Whether the feed is live now: the relay keeps its subscriptions open. */
  onStatus(live: boolean): void;
  log?(message: string): void;
}>;

export class AgentFeed {
  /** The channels the relay lists the agent in. */
  readonly channels = new Set<string>();
  /** The same channels in the order they were found, which batches them. */
  private readonly order: string[] = [];
  /** Each channel's members, from its newest roster (`id`). */
  private readonly rosters = new Map<
    string,
    { at: number; id: string; members: readonly string[] }
  >();
  /** Each channel's type (the first `t` tag of its newest metadata). */
  private readonly types = new Map<string, { at: number; type?: string }>();
  /** Channels whose metadata the relay has not finished sending, with the
   * events heard in them meanwhile. Whether a channel is a DM decides how
   * its messages wake the agent, so they wait until it is known. */
  private readonly loading = new Map<string, LiveBatch[]>();
  /** Events heard while the feed was not live, as while one subscription is
   * asked for again and the others are still open. The host takes events
   * only while it is listening, so they wait until then. */
  private paused: LiveBatch[] = [];
  private live = false;
  private socket: WebSocket | undefined;
  /** The newest event heard: an open subscription has heard to here. */
  private since = Math.floor(Date.now() / 1000);
  /** Where each closed subscription stopped hearing, until a new request
   * for it has sent what it missed (EOSE). Others go on meanwhile, and move
   * `since` past what it missed. */
  private readonly pinned = new Map<string, number>();
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cleanup: (() => void) | undefined;
  constructor(private readonly options: FeedOptions) {}

  /** Whether the channel is a DM of exactly the agent and one other, by its
   * roster and metadata. A group DM, or one either is unknown for, is not. */
  dm(channel: string) {
    const members = this.rosters.get(channel)?.members;
    return (
      this.types.get(channel)?.type === "dm" &&
      members?.length === 2 &&
      members.includes(this.options.pubkey)
    );
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.cleanup?.();
    this.socket?.close();
    this.socket = undefined;
    this.paused = [];
  }

  private setLive(live: boolean) {
    this.live = live;
    this.options.onStatus(live);
    if (!live) return;
    const paused = this.paused;
    this.paused = [];
    for (const batch of paused) this.options.onEvents(batch);
  }
  /** Gives the event on now, or once the feed is live. */
  private deliver(batch: LiveBatch) {
    if (this.live) return this.options.onEvents(batch);
    // Heard again, as after a reconnect, it waits once.
    const id = batch.events[0]?.id;
    if (this.paused.some((paused) => paused.events[0]?.id === id)) return;
    // Given on in a burst, which live delivery would drop past the agent's
    // room.
    this.paused.push({ ...batch, replay: true });
    if (this.paused.length > HELD_LIMIT) {
      this.paused.shift();
      this.options.log?.("Dropped an event heard while not listening");
    }
  }
  /** Marks where `key`'s stream stopped, unless it already stopped. */
  private pin(key: string) {
    if (!this.pinned.has(key)) this.pinned.set(key, this.since);
  }

  private connect() {
    const { relay, log } = this.options;
    const socket = new WebSocket(relay);
    this.socket = socket;
    let authed = false;
    let subscribed = false;
    let serial = 0;
    /** Each subscription key's latest request id, and the key of each id. */
    const current = new Map<string, string>();
    const keys = new Map<string, string>();
    /** The ids the relay has not closed. */
    const open = new Set<string>();
    /** The ids whose stored events the relay is still sending (no EOSE). */
    const stored = new Set<string>();
    /** The channels each metadata request settles once the relay has sent
     * what it has (EOSE). */
    const settles = new Map<string, readonly string[]>();
    /** Keys the relay refused, until the next connection. */
    const denied = new Set<string>();
    /** Keys waiting to be asked again, with their failures so far. */
    const retries = new Map<
      string,
      { attempt: number; timer?: ReturnType<typeof setTimeout> }
    >();
    this.cleanup = () => {
      for (const retry of retries.values()) clearTimeout(retry.timer);
      retries.clear();
    };
    const send = (message: unknown[]) => socket.send(JSON.stringify(message));
    const batches = () => Math.ceil(this.order.length / CHANNEL_BATCH);
    const batch = (index: number) =>
      this.order.slice(index * CHANNEL_BATCH, (index + 1) * CHANNEL_BATCH);
    const all = () => [
      "mentions",
      "rosters",
      ...Array.from({ length: batches() }, (_, index) => [
        `channels:${index}`,
        `metadata:${index}`,
      ]).flat(),
    ];
    const isOpen = (key: string) => {
      const id = current.get(key);
      return !!id && open.has(id);
    };
    const filter = (key: string): Record<string, unknown> => {
      const since = Math.max(
        0,
        (this.pinned.get(key) ?? this.since) - OVERLAP_S,
      );
      const [kind, index] = key.split(":");
      if (kind === "mentions")
        return { kinds: KINDS, "#p": [this.options.pubkey], since };
      if (kind === "rosters")
        return { kinds: [39002], "#p": [this.options.pubkey] };
      const channels = batch(Number(index));
      return kind === "channels"
        ? { kinds: KINDS, "#h": channels, since }
        : { kinds: [39000], "#d": channels };
    };
    /** Asks for `key` as it is now, replacing an earlier request for it. */
    const ask = (key: string) => {
      const old = current.get(key);
      if (old && open.delete(old)) send(["CLOSE", old]);
      if (old) {
        keys.delete(old);
        settles.delete(old);
      }
      const waiting = retries.get(key);
      if (waiting?.timer) {
        clearTimeout(waiting.timer);
        retries.set(key, { attempt: waiting.attempt });
      }
      const id = key.includes(":") ? `${key}:${++serial}` : key;
      current.set(key, id);
      keys.set(id, key);
      open.add(id);
      stored.add(id);
      const asked = filter(key);
      if (key.startsWith("metadata:")) settles.set(id, asked["#d"] as string[]);
      send(["REQ", id, asked]);
    };
    // Live while the relay keeps the mentions, rosters and every channel
    // batch's subscription it allows. The relay drops a channel the agent
    // left from a batch's subscription, and refuses the batch only once the
    // agent can read none of its channels: that batch has nothing to hear,
    // so the others go on without it.
    const status = () =>
      this.setLive(
        all()
          .filter(
            (key) =>
              !key.startsWith("metadata:") &&
              !(key.startsWith("channels:") && denied.has(key)),
          )
          .every(isOpen),
      );
    /** Asks again for the batch that hears `channel`, though the relay
     * refused it or holds it open. */
    const reopen = (channel: string) => {
      const index = Math.floor(this.order.indexOf(channel) / CHANNEL_BATCH);
      for (const key of [`channels:${index}`, `metadata:${index}`]) {
        denied.delete(key);
        ask(key);
      }
      status();
    };
    /** Opens each subscription that is not open, refused or waiting to be
     * asked again: all at first, and after a login the ones the relay closed
     * until the agent logged in. */
    const subscribe = () => {
      subscribed = true;
      for (const key of all())
        if (!isOpen(key) && !denied.has(key) && !retries.get(key)?.timer)
          ask(key);
      status();
    };
    /** Asks for `key` again after a wait that grows with each failure. */
    const retry = (key: string) => {
      const attempt = retries.get(key)?.attempt ?? 0;
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 30_000;
      const timer = setTimeout(() => {
        retries.set(key, { attempt: attempt + 1 });
        if (this.socket === socket && socket.readyState === WebSocket.OPEN)
          if (!isOpen(key)) ask(key);
        status();
      }, wait);
      retries.set(key, { attempt: attempt + 1, timer });
      log?.(`Asking for ${key} again in ${wait / 1000}s`);
    };
    socket.addEventListener("open", () => {
      log?.(`Connected to ${relay}`);
      // A relay that asks for no login hears the subscriptions as they are.
      setTimeout(() => {
        if (!authed && socket.readyState === WebSocket.OPEN) subscribe();
      }, 2_000);
    });
    socket.addEventListener("message", (message) => {
      let data: unknown[];
      try {
        data = JSON.parse(String(message.data)) as unknown[];
      } catch {
        return;
      }
      const [type] = data;
      if (type === "AUTH" && typeof data[1] === "string") {
        const event = finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            content: "",
            tags: [
              ["relay", relay],
              ["challenge", data[1]],
              ...(this.options.auth ? [[...this.options.auth]] : []),
            ],
          },
          this.options.secret,
        );
        send(["AUTH", event]);
        return;
      }
      if (type === "OK" && !authed) {
        if (data[2] === true) {
          authed = true;
          this.attempt = 0;
          subscribe();
        } else log?.(`Login refused: ${String(data[3])}`);
        return;
      }
      if (type === "EOSE") {
        const id = String(data[1]);
        stored.delete(id);
        const key = keys.get(id);
        if (key) {
          retries.delete(key);
          // Its missed events are sent: it hears on from here.
          this.pinned.delete(key);
        }
        for (const channel of settles.get(id) ?? []) this.settle(channel);
        settles.delete(id);
        return;
      }
      if (type === "CLOSED") {
        const id = String(data[1]);
        const reason = String(data[2] ?? "");
        const key = keys.get(id);
        // One replaced since, or not this feed's.
        if (!key || current.get(key) !== id) return;
        log?.(`Subscription ${key} closed: ${reason}`);
        open.delete(id);
        this.pin(key);
        if (!authed && reason.startsWith("auth-required:")) {
          // Opens again once the agent has logged in.
        } else if (DENIED.test(reason)) {
          denied.add(key);
          // Its channels' facts will not come on this connection: their
          // events go on as in channels that are not DMs.
          for (const channel of settles.get(id) ?? []) this.settle(channel);
          settles.delete(id);
        } else retry(key);
        status();
        return;
      }
      if (type === "NOTICE") {
        log?.(`Notice: ${String(data[1])}`);
        return;
      }
      if (type !== "EVENT") return;
      let event: RelayEvent;
      try {
        [event] = eventsDto([data[2]]) as [RelayEvent];
      } catch {
        return;
      }
      const from = keys.get(String(data[1])) ?? "";
      if (from.startsWith("metadata:")) {
        const id = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (id && event.created_at >= (this.types.get(id)?.at ?? 0)) {
          const type = event.tags.find((tag) => tag[0] === "t")?.[1];
          this.types.set(id, {
            at: event.created_at,
            ...(type ? { type } : {}),
          });
        }
        return;
      }
      if (from === "rosters") {
        const id = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (!id) return;
        const previous = this.rosters.get(id);
        const changed =
          event.created_at >= (previous?.at ?? 0) && event.id !== previous?.id;
        if (changed)
          this.rosters.set(id, {
            at: event.created_at,
            id: event.id,
            members: [
              ...new Set(
                event.tags.flatMap((tag) =>
                  tag[0] === "p" && tag[1] ? [tag[1]] : [],
                ),
              ),
            ],
          });
        if (!this.channels.has(id)) {
          this.channels.add(id);
          this.order.push(id);
          this.loading.set(id, []);
        } else if (
          !changed ||
          !this.rosters.get(id)?.members.includes(this.options.pubkey)
        )
          return;
        // A new channel, or a new roster of one the agent is in, which may
        // be its way back in: this subscription hears no roster that leaves
        // the agent out, and the relay drops a channel the agent left from
        // its batch's subscription without closing it, unless it was the
        // batch's last. So its batch is asked for again, as it is now.
        if (subscribed) reopen(id);
        return;
      }
      this.since = Math.max(this.since, event.created_at);
      const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
      const live: LiveBatch = {
        events: [event],
        ...(channelId ? { channelId } : {}),
        // What it missed, as after a drop: given as it has room.
        ...(stored.has(String(data[1])) ? { replay: true as const } : {}),
      };
      const held = channelId && this.loading.get(channelId);
      if (!held) {
        this.deliver(live);
        return;
      }
      // Heard again, as after a reconnect, it is held once.
      if (held.some((batch) => batch.events[0]?.id === event.id)) return;
      held.push(live);
      if (held.length > HELD_LIMIT) {
        held.shift();
        log?.(`Dropped an event from ${channelId} while its type loads`);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      for (const retry of retries.values()) clearTimeout(retry.timer);
      retries.clear();
      // Each open one stopped here; a closed one stopped earlier.
      for (const key of current.keys()) this.pin(key);
      this.setLive(false);
      if (this.stopped) return;
      const wait =
        RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)] ?? 30_000;
      log?.(`Disconnected; trying again in ${wait / 1000}s`);
      this.timer = setTimeout(() => this.connect(), wait);
    });
    socket.addEventListener("error", () => {});
  }
  /** The channel's facts are known, or will not come: the events held for
   * it go on, in the order heard. */
  private settle(channel: string) {
    const held = this.loading.get(channel);
    if (!held) return;
    this.loading.delete(channel);
    for (const batch of held) this.deliver(batch);
  }
}
