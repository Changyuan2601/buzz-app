// The agent's live feed on a standalone host: one WebSocket to its community,
// logged in as the agent (NIP-42, carrying its owner's attestation), that
// hears what names the agent and everything in the channels it is in. It
// reconnects after a drop and picks up from the last event it heard.
import { finalizeEvent } from "nostr-tools/pure";
import { CHAT_KINDS } from "../features/agents/attention";
import { eventsDto, type RelayEvent } from "../features/relay/events";
import type { LiveBatch } from "../features/relay/incoming";

const KINDS = [...new Set([...CHAT_KINDS, 4, 5, 7, 40002])];
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Catch-up after a drop reaches back this far before the last event heard. */
const OVERLAP_S = 30;

export type FeedOptions = Readonly<{
  relay: string;
  secret: Uint8Array;
  pubkey: string;
  /** The owner's NIP-OA `auth` tag. */
  auth?: readonly string[];
  /** Live events, one batch per event, with the event's channel. */
  onEvents(batch: LiveBatch): void;
  /** Whether the feed is live now: the relay keeps its subscriptions open. */
  onStatus(live: boolean): void;
  log?(message: string): void;
}>;

export class AgentFeed {
  /** The channels the relay lists the agent in. */
  readonly channels = new Set<string>();
  /** Each channel's members, from its newest roster. */
  private readonly rosters = new Map<
    string,
    { at: number; members: readonly string[] }
  >();
  /** Each channel's type (the first `t` tag of its newest metadata). */
  private readonly types = new Map<string, { at: number; type?: string }>();
  private socket: WebSocket | undefined;
  private since = Math.floor(Date.now() / 1000);
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
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
    this.socket?.close();
    this.socket = undefined;
  }

  private connect() {
    const { relay, log } = this.options;
    const socket = new WebSocket(relay);
    this.socket = socket;
    let authed = false;
    /** The subscriptions the relay has not closed. */
    const open = new Set<string>();
    const send = (message: unknown[]) => socket.send(JSON.stringify(message));
    const req = (id: string, filter: Record<string, unknown>) => {
      open.add(id);
      send(["REQ", id, filter]);
    };
    // Live while the relay keeps the mentions and channel subscriptions.
    const status = () =>
      this.options.onStatus(
        open.has("mentions") &&
          open.has("rosters") &&
          (!this.channels.size || open.has("channels")),
      );
    /** Opens each subscription that is not open: all at first, and after a
     * login the ones the relay closed until the agent logged in. */
    const subscribe = () => {
      const since = Math.max(0, this.since - OVERLAP_S);
      if (!open.has("mentions"))
        req("mentions", { kinds: KINDS, "#p": [this.options.pubkey], since });
      if (!open.has("rosters"))
        req("rosters", { kinds: [39002], "#p": [this.options.pubkey] });
      if (!open.has("channels")) this.channelsChanged(req, since);
      if (!open.has("metadata")) this.metadataChanged(req);
      status();
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
      if (type === "CLOSED") {
        log?.(`Subscription ${String(data[1])} closed: ${String(data[2])}`);
        // One closed until the agent logs in opens again after the login.
        open.delete(String(data[1]));
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
      if (data[1] === "metadata") {
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
      if (data[1] === "rosters") {
        const id = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (!id) return;
        if (event.created_at >= (this.rosters.get(id)?.at ?? 0))
          this.rosters.set(id, {
            at: event.created_at,
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
          this.channelsChanged(req, Math.max(0, this.since - OVERLAP_S));
          this.metadataChanged(req);
          status();
        }
        return;
      }
      this.since = Math.max(this.since, event.created_at);
      const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
      this.options.onEvents({
        events: [event],
        ...(channelId ? { channelId } : {}),
      });
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.options.onStatus(false);
      if (this.stopped) return;
      const wait =
        RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)] ?? 30_000;
      log?.(`Disconnected; trying again in ${wait / 1000}s`);
      this.timer = setTimeout(() => this.connect(), wait);
    });
    socket.addEventListener("error", () => {});
  }
  /** Hears every channel the agent is in, as of now. */
  private channelsChanged(
    req: (id: string, filter: Record<string, unknown>) => void,
    since: number,
  ) {
    if (!this.channels.size) return;
    req("channels", { kinds: KINDS, "#h": [...this.channels], since });
  }
  /** Hears the metadata, and so the type, of every channel the agent is in. */
  private metadataChanged(
    req: (id: string, filter: Record<string, unknown>) => void,
  ) {
    if (!this.channels.size) return;
    req("metadata", { kinds: [39000], "#d": [...this.channels] });
  }
}
