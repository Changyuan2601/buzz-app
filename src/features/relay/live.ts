import { getLogger } from "../developer/logging.ts";
import { logSocketFrame, relayLabel } from "../developer/traffic.ts";

import {
  createSocketPublications,
  SocketRequestError,
} from "./socket-requests.ts";
import {
  OBSERVER_KIND,
  observerGeneration,
  type ObserverFrame,
} from "../agents/observer.ts";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { eventDto } from "./events.ts";
import { EMOJI_SET } from "./emoji.ts";

export const LIVE_CHANNEL_CAPACITY = 1022;
export const LIVE_INTEREST_CAPACITY = 100_000;
export const LIVE_GROUP_SIZE = 1000;
export const LIVE_BATCH_SIZE = 10; // Relay's per-REQ filter cap; replay stays per channel.
export const LIVE_REPLAY_LIMIT = 500;
export const LIVE_RECOVERY_INTERVAL = 60_000;
/** Channel REQs awaiting EOSE at once. `scripts/live-setup-probe.mjs` compares others. */
export const SETUP_CONCURRENCY = 4;
/** How long one channel REQ may wait for EOSE before its route fails. */
export const SETUP_TIMEOUT_MS = 10_000;
const MAX_QUOTA_RETRIES = 3;
const BASE_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 30_000;
/** Host-owned server cooldown survives socket/POST replacement.
 * Healthy traffic has no inter-request delay; outstanding work is bounded below. */
export function createLiveAdmission() {
  let cooldown = 0;
  let presenceBusy = false,
    presenceNext = 0;
  const pending = new Set<object>();
  return {
    delay: () => Math.max(0, cooldown - performance.now()),
    setup(owner: object, busy: boolean) {
      if (busy) pending.add(owner);
      else pending.delete(owner);
    },
    presenceReady: () => performance.now() >= Math.max(cooldown, presenceNext),
    presenceDelay: () =>
      Math.ceil(
        Math.max(0, Math.max(cooldown, presenceNext) - performance.now()),
      ),
    tryPresence() {
      if (presenceBusy || !this.presenceReady()) return;
      presenceBusy = true;
      return () => {
        presenceBusy = false;
      };
    },
    presenceSent() {
      presenceNext = performance.now() + 5000;
    },
    presenceIdle: () =>
      !presenceBusy && performance.now() >= presenceNext && !pending.size,
    pause(seconds: number) {
      // Redis reports whole seconds; include a second rather than retry before expiry.
      cooldown = Math.max(cooldown, performance.now() + (seconds + 1) * 1000);
    },
  };
}
export type LiveAdmission = ReturnType<typeof createLiveAdmission>;
export type LiveRoute = Readonly<{
  id: string;
  channelId?: string;
  status: "pending" | "live" | "error" | "limited";
  /** EOSE establishes a stream, never proves historical completeness. */
  replay: "unknown" | "limited";
  error?: string;
}>;
export type LiveSnapshot = Readonly<{
  status: "unavailable" | "connecting" | "connected" | "retrying" | "error";
  routes: readonly LiveRoute[];
  error?: string;
}>;
/** Transport provenance, not a history-completeness claim or permission to alert. */
export type LiveProvenance = Readonly<{
  phase: "replay" | "live";
  channelId?: string;
  /** Original wire scope for ambiguous channel traffic; never alert attribution. */
  sourceChannels?: readonly string[];
}>;
export function liveProvenance(value: unknown): LiveProvenance {
  if (!value || typeof value !== "object")
    throw new Error("Invalid live provenance");
  const input = value as Record<string, unknown>;
  if (input.phase !== "replay" && input.phase !== "live")
    throw new Error("Invalid live provenance");
  if (
    input.channelId !== undefined &&
    (typeof input.channelId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.channelId))
  )
    throw new Error("Invalid live provenance channel");
  const sourceChannels =
    input.sourceChannels === undefined
      ? undefined
      : liveChannels(input.sourceChannels);
  if (
    sourceChannels &&
    (!sourceChannels.length || sourceChannels.length > LIVE_GROUP_SIZE)
  )
    throw new Error("Invalid live source scope");
  return Object.freeze({
    ...(sourceChannels
      ? { sourceChannels: Object.freeze(sourceChannels) }
      : {}),
    phase: input.phase,
    ...(typeof input.channelId === "string"
      ? { channelId: input.channelId }
      : {}),
  });
}
export type LiveCallbacks = {
  /** Legacy/missing provenance reconciles quietly; it is never implicitly fresh. */
  receive(events: readonly VerifiedEvent[], provenance?: LiveProvenance): void;
  /** Host-only encrypted telemetry route; never ordinary history reconciliation. */
  telemetry?(event: VerifiedEvent, generation: number): void;
  /** Decoded host DTO on the browser transport. */
  observer?(frame: ObserverFrame, generation: number): void;
  presence?(event: VerifiedEvent): void;
  state(snapshot: LiveSnapshot): void;
  established(channels?: string | readonly string[]): void;
  /** Periodic repair hint, not membership or historical-completeness evidence. */
  recover?(): void;
  denied(channelId: string, reason: string): void;
};
export type LiveSubscription = {
  /** Local broker handle; not a relay subscription ID. */
  identity?(): string | undefined;
  publish?(event: VerifiedEvent, signal: AbortSignal): Promise<string>;
  /** Purpose-bound host path when generic socket publication is unavailable. */
  publishTyping?(event: VerifiedEvent, signal: AbortSignal): Promise<string>;
  update(channels: readonly string[], joined?: readonly string[]): void;
  /** Host demand only: reorder existing pending routes, never grant new interests. */
  prioritize?(channels: readonly string[]): void;
  observe?(generation: number | null): void;
  /** Ephemeral status: true = accepted, false = unconfirmed/refused, null = unsent.
   * Admission skips report their remaining delay; no durable queue is created. */
  publishPresence?(
    status: "online" | "away" | "offline",
    signal: AbortSignal,
  ): Promise<boolean | null | { retryAfterMs: number }>;
  watchPresence?(authors: readonly string[]): void;
  retry(): void;
  dispose(): void;
};
/** Demand-scoped ephemeral authors, never a channel/history interest. */
export function livePresenceAuthors(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 256 ||
    input.some((key) => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key))
  )
    throw new Error("Invalid live presence authors");
  return [...new Set(input as string[])].sort();
}
/** IDs, not names/previews, define interest identity. Never silently truncate. */
export function liveChannels(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > LIVE_INTEREST_CAPACITY ||
    input.some(
      (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id),
    )
  )
    throw new Error(
      "Invalid live channel interests (maximum 100000 bounded IDs)",
    );
  return [...new Set(input as string[])].sort();
}

/** Batchability is part of the same interest snapshot, not a priority hint. */
export function liveJoined(
  channels: readonly string[],
  input: unknown,
): string[] {
  const joined = liveChannels(input);
  const allowed = new Set(channels);
  if (joined.some((id) => !allowed.has(id)))
    throw new Error("Joined scope outside live interests");
  return joined;
}

type Route = {
  id: string;
  channelId?: string;
  channelIds?: readonly string[];
  status: LiveRoute["status"];
  replay: LiveRoute["replay"];
  error?: string;
  wire?: string;
  count: number;
  since: number;
  liveOnly?: boolean;
  previous?: Route;
  retryRenewal?: boolean;
  quotaRetries: number;
  deadline?: ReturnType<typeof setTimeout>;
  replayOffset?: number;
  historyParent?: string;
  priorityRank?: number;
};
export const CHANNEL_KINDS = [
  9, 40002, 40008, 45001, 45003, 40099, 40100, 40003, 5, 9005, 7, 39000, 39002,
  39005, 20002, 45010, 48100, 48101, 48102, 48103,
];
/** One authenticated socket, bounded joined-channel batches, singleton previews and two globals.
 * Recent replay is opportunistic: finite reads own catch-up and history bounds. */
export function subscribeRelayTraffic(
  url: string,
  sign: (event: EventTemplate) => Promise<VerifiedEvent>,
  viewer: string,
  callbacks: LiveCallbacks,
  socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
  admission: LiveAdmission = createLiveAdmission(),
  setupConcurrency = SETUP_CONCURRENCY,
  setupTimeoutMs = SETUP_TIMEOUT_MS,
): LiveSubscription {
  const log = getLogger("relay-ws");
  const peer = relayLabel(url);
  let closed = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = BASE_RECONNECT_DELAY;
  let generation = 0,
    serial = 0;
  let authenticated = false;
  let connection: LiveSnapshot["status"] = "connecting";
  let connectionError: string | undefined;
  let interests: string[] = [];
  let joined: string[] = [];
  // Keep denial callbacks in one scheduling transaction; updates can retire
  // individual lifetimes without admitting a replacement mid-denial.
  let denying: Set<string> | undefined;
  let priority: string[] = [];
  let observer: number | null = null;
  let presenceAuthors: readonly string[] = [];
  let presenceReceipt:
    | { id: string; finish(accepted: boolean): void }
    | undefined;
  const routes = new Map<string, Route>();
  const wires = new Map<string, Route>();
  const notify = () => {
    admission.setup(
      routes,
      !closed &&
        connection !== "error" &&
        [...routes.values()].some((route) => route.status === "pending"),
    );
    if (closed) return;
    callbacks.state(
      Object.freeze({
        status: connection,
        routes: Object.freeze(
          [...routes.values()]
            .filter((route) => !route.historyParent)
            .flatMap((route) => {
              const { id, channelId, channelIds, status, replay, error } =
                route;
              return (channelIds ?? [channelId]).map((channelId) => {
                const retained =
                  channelId &&
                  route.previous?.status === "live" &&
                  route.previous.wire &&
                  scope(route.previous).length < scope(route).length &&
                  scope(route.previous).includes(channelId);
                return Object.freeze({
                  id: channelId ? `channel:${channelId}` : id,
                  ...(channelId ? { channelId } : {}),
                  status: retained ? ("live" as const) : status,
                  replay: retained
                    ? (route.previous?.replay ?? replay)
                    : replay,
                  ...(!retained && error ? { error } : {}),
                });
              });
            }),
        ),
        ...(connectionError ? { error: connectionError } : {}),
      }),
    );
  };
  const send = (value: unknown) => {
    if (!closed && socket?.readyState === 1) {
      const raw = JSON.stringify(value);
      socket.send(raw);
      logSocketFrame(peer, "→", raw, value);
    }
  };
  const requests = createSocketPublications(() => queueMicrotask(pump));
  function closeWire(route: Route) {
    clearTimeout(route.deadline);
    if (route.wire) {
      wires.delete(route.wire); // Fence before CLOSE, including reentrant callbacks.
      send(["CLOSE", route.wire]);
      delete route.wire;
    }
    if (route.previous) closeWire(route.previous);
    delete route.previous;
  }
  function remove(route: Route) {
    if (!route.historyParent) {
      const history = routes.get(`replay:${route.id}`);
      if (history) remove(history);
    }
    closeWire(route);
    routes.delete(route.id);
  }
  const scope = (route: Route) =>
    route.channelIds ?? (route.channelId ? [route.channelId] : []);
  function replace(route: Route, ids = scope(route)) {
    // A sent replacement is not yet established. Keep the established source
    // through repeated removals; retire the pending intermediate, not a survivor.
    if (
      route.replayOffset !== undefined &&
      JSON.stringify(ids) !== JSON.stringify(scope(route)) &&
      !scope(route).every((id, index) => ids[index] === id)
    ) {
      const history = routes.get(`replay:${route.id}`);
      if (history) remove(history);
      route.replayOffset = 0;
    }
    const previous = route.previous ?? (route.wire ? route : undefined);
    delete route.previous;
    if (previous !== route) closeWire(route); // Never retain a third wire.
    clearTimeout(route.deadline);
    const next: Route = {
      ...route,
      ...(route.channelIds ? { channelIds: ids } : {}),
      status: "pending",
      liveOnly: true,
      count: 0,
      quotaRetries: 0,
      ...(previous ? { previous } : {}),
    };
    delete next.wire;
    delete next.deadline;
    delete next.retryRenewal;
    routes.set(next.id, next);
    return next;
  }
  function recover() {
    if (closed || !authenticated) return;
    // A minute authenticated restores prompt recovery for the next rollout;
    // opening/authenticating alone must not reset backoff on a flapping relay.
    reconnectDelay = BASE_RECONNECT_DELAY;
    const current = generation;
    // Only multi-channel scopes can be silently pruned by this relay. Singleton
    // preview/legacy callers retain their existing CLOSED/retry behavior.
    for (const route of routes.values()) {
      if (route.channelIds && route.status === "live" && !route.previous)
        replace(route);
      else if (
        route.status === "error" &&
        route.retryRenewal &&
        route.previous?.wire
      ) {
        route.status = "pending";
        delete route.retryRenewal;
      }
    }
    pump();
    notify();
    if (closed || generation !== current) return;
    callbacks.recover?.();
    if (!closed && authenticated && generation === current)
      recoveryTimer = setTimeout(recover, LIVE_RECOVERY_INTERVAL);
  }
  function sync() {
    if (denying || closed) return;
    const ranked = [
      ...new Set([
        ...priority.filter((id) => interests.includes(id)),
        ...interests,
      ]),
    ];
    const joinedSet = new Set(joined);
    const prioritySet = new Set(priority);
    const staged = joined.length > LIVE_CHANNEL_CAPACITY;
    const groupSize = staged ? LIVE_GROUP_SIZE : LIVE_BATCH_SIZE;
    const capacity =
      LIVE_CHANNEL_CAPACITY -
      (observer !== null ? 1 : 0) -
      (presenceAuthors.length ? 1 : 0) -
      (joined.length ? 1 : 0) -
      (staged ? SETUP_CONCURRENCY : 0);
    const interestSet = new Set(interests);
    const retained = new Map<string, Route>();
    for (const route of routes.values()) {
      if (route.historyParent || route.status === "limited") continue;
      for (const id of scope(route)) {
        if (interestSet.has(id) && (!route.channelIds || joinedSet.has(id)))
          retained.set(id, route);
      }
    }
    const admitted = new Set<string>();
    const kept = new Set<Route>();
    let singles = 0,
      grouped = 0,
      free = 0;
    for (const id of ranked) {
      const route = retained.get(id);
      const batchable = joinedSet.has(id) && (staged || !prioritySet.has(id));
      const newRoute = route && !kept.has(route) ? 1 : 0;
      const nextFree =
        free +
        (newRoute && route?.channelIds && !route.previous
          ? Math.max(
              0,
              groupSize -
                scope(route).filter(
                  (channel) =>
                    interestSet.has(channel) && joinedSet.has(channel),
                ).length,
            )
          : 0);
      const nextSingles = singles + (!route && !batchable ? 1 : 0);
      const nextGrouped = grouped + (!route && batchable ? 1 : 0);
      const cost =
        kept.size +
        newRoute +
        nextSingles +
        Math.ceil(Math.max(0, nextGrouped - nextFree) / groupSize);
      if (cost > capacity) continue;
      admitted.add(id);
      if (route) kept.add(route);
      singles = nextSingles;
      grouped = nextGrouped;
      free = nextFree;
    }
    const remaining = new Set(interests);
    const globals = new Set([
      "profiles",
      "membership",
      ...(observer !== null ? ["observer"] : []),
      ...(presenceAuthors.length ? ["presence"] : []),
    ]);
    // Scope is immutable for a wire. Retirement rebuilds only the affected batch;
    // navigation is scheduling, never a reason to rebalance healthy subscriptions.
    for (const route of routes.values()) {
      delete route.priorityRank;
      if (route.historyParent) continue;
      const ids = scope(route);
      if (
        ids.length
          ? ids.some(
              (id) =>
                !remaining.has(id) ||
                (route.status === "limited") === admitted.has(id) ||
                (!!route.channelIds && !joinedSet.has(id)),
            )
          : !globals.has(route.id)
      ) {
        const survivors = ids.filter(
          (id) => remaining.has(id) && admitted.has(id) && joinedSet.has(id),
        );
        if (
          route.channelIds &&
          survivors.length &&
          (route.status === "live" || route.liveOnly)
        ) {
          replace(route, survivors);
          for (const id of survivors) remaining.delete(id);
        } else remove(route);
      } else {
        for (const id of ids) remaining.delete(id);
        globals.delete(route.id);
      }
    }
    const add = (id: string, ids: readonly string[] = [], batch = false) => {
      const route: Route = {
        id,
        ...(batch ? { channelIds: ids } : ids[0] ? { channelId: ids[0] } : {}),
        status: "pending",
        replay: "unknown",
        count: 0,
        quotaRetries: 0,
        since: Math.floor(Date.now() / 1000) - 300,
      };
      routes.set(id, route);
      return route;
    };
    for (const id of globals) {
      const route = add(id);
      if (id === "presence") route.liveOnly = true;
    }
    const batch: string[] = [];
    for (const id of remaining) {
      if (!admitted.has(id)) {
        const route = add(`channel:${id}`, [id]);
        route.status = "limited";
        route.error =
          "Live channel capacity reached; finite reads remain available";
      } else if (!joinedSet.has(id) || (!staged && prioritySet.has(id)))
        add(`channel:${id}`, [id]);
      else batch.push(id);
    }
    for (const route of [...routes.values()]) {
      if (!batch.length) break;
      if (
        !route.channelIds ||
        route.historyParent ||
        route.status === "limited" ||
        route.status === "error" ||
        route.previous
      )
        continue;
      const extra = batch.splice(
        0,
        Math.max(0, groupSize - route.channelIds.length),
      );
      if (!extra.length) continue;
      const next = replace(route, [...route.channelIds, ...extra]);
      next.replayOffset =
        route.replayOffset ??
        (route.status === "live" ? route.channelIds.length : 0);
    }
    for (let i = 0; i < batch.length; i += groupSize) {
      const route = add(
        `batch:${++serial}`,
        batch.slice(i, i + groupSize),
        true,
      );
      if (staged) {
        route.liveOnly = true;
        route.replayOffset = 0;
      }
    }
    pump();
    notify();
  }
  function fail(route: Route, reason: string, transient = false) {
    if (route.historyParent) {
      const parent = routes.get(route.historyParent);
      if (parent) {
        parent.replay = "limited";
        parent.error = reason;
      }
    }
    const previous = route.previous;
    // A transient failure can retain an established subset. Denial and invalid
    // traffic still retire the wire, and removed channels never regain coverage.
    const retain =
      transient &&
      previous?.status === "live" &&
      previous.wire &&
      wires.get(previous.wire) === previous &&
      scope(previous).every((id) => scope(route).includes(id));
    if (retain) delete route.previous;
    closeWire(route);
    delete route.retryRenewal;
    if (retain) {
      route.previous = previous;
      // Quota owns its existing bounded retries; the minute timer cannot reset it.
      route.retryRenewal = !reason.startsWith("rate-limited:");
    }
    route.status = "error";
    route.error = reason;
    if (reason.startsWith("rate-limited:")) {
      const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
        reason,
      );
      const seconds = hint ? Number(hint[1]) : 5;
      if (!Number.isSafeInteger(seconds) || seconds > 60) {
        for (const queued of routes.values())
          if (queued.status === "pending" && !queued.wire) {
            queued.status = "error";
            queued.error = "Unsupported live cooldown; automatic setup stopped";
          }
        // Conservative shared pause survives replacement; never overflow a timer.
        admission.pause(
          Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
        );
      } else {
        admission.pause(seconds);
        if (++route.quotaRetries <= MAX_QUOTA_RETRIES) route.status = "pending";
        else {
          // Stop the unsent queue too: rejection must never drain it into an exhausted budget.
          for (const queued of routes.values())
            if (queued.status === "pending" && !queued.wire) {
              queued.status = "error";
              queued.error =
                "Live request cooldown retries exhausted; retry available";
            }
        }
      }
    }
    if (reason === "restricted: not a channel member") {
      const current = generation;
      const denied = new Set(scope(route));
      denying = denied;
      try {
        notify();
        for (const id of denied) {
          if (closed || generation !== current) break;
          callbacks.denied(id, reason);
        }
      } finally {
        denying = undefined;
        sync();
      }
    } else notify();
    pump();
  }
  function pump() {
    clearTimeout(dispatchTimer);
    if (closed || denying || !authenticated || socket?.readyState !== 1) return;
    for (let request = requests.next(); request; request = requests.next()) {
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        return;
      }
      requests.dispatch(request, send);
    }
    for (const parent of [...routes.values()]) {
      if (
        parent.replayOffset === undefined ||
        parent.status !== "live" ||
        parent.replayOffset >= scope(parent).length ||
        routes.has(`replay:${parent.id}`)
      )
        continue;
      const history: Route = {
        id: `replay:${parent.id}`,
        historyParent: parent.id,
        channelIds: scope(parent).slice(
          parent.replayOffset,
          parent.replayOffset + LIVE_BATCH_SIZE,
        ),
        status: "pending",
        replay: "unknown",
        count: 0,
        since: parent.since,
        quotaRetries: 0,
      };
      routes.set(history.id, history);
    }
    let active = [...routes.values()].filter(
      (route) => route.wire && route.status === "pending",
    ).length;
    const rank = (route: Route) =>
      (route.priorityRank ??= !scope(route).length
        ? -2
        : Math.min(
            priority.length,
            ...scope(route).map((id) =>
              priority.includes(id) ? priority.indexOf(id) : priority.length,
            ),
          ));
    for (const route of [...routes.values()].sort(
      (a, b) => rank(a) - rank(b),
    )) {
      if (active >= setupConcurrency) break;
      if (route.status !== "pending" || route.wire) continue;
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        break;
      }
      if (wires.size >= 1024) {
        if (route.previous?.wire) continue;
        route.status = "limited";
        route.error =
          "Live subscription capacity reached; retry after demand changes";
        notify();
        continue;
      }
      // A retry being sent is not recovery. Retain its last failure until EOSE.
      const wire = `live-${++serial}`;
      route.wire = wire;
      wires.set(wire, route);
      route.deadline = setTimeout(() => {
        if (wires.get(wire) === route)
          fail(
            route,
            "Live subscription setup timed out; retry available",
            true,
          );
      }, setupTimeoutMs);
      active++;
      if (route.id === "observer") route.since = Math.floor(Date.now() / 1000);
      const filters = scope(route).length
        ? (route.liveOnly
            ? [scope(route)]
            : scope(route).map((id) => [id])
          ).map((ids) => ({ kinds: CHANNEL_KINDS, "#h": ids }))
        : route.id === "presence"
          ? [{ kinds: [20001], authors: presenceAuthors }]
          : route.id === "profiles"
            ? [{ kinds: [0, 10100, 30177] }]
            : route.id === "observer"
              ? [{ kinds: [OBSERVER_KIND], "#p": [viewer] }]
              : [
                  { kinds: [44100, 44101], "#p": [viewer] },
                  // NIP-CL: the relay sends a system channel's notices only
                  // to a filter that asks for them with #t.
                  { kinds: [44100, 44101], "#p": [viewer], "#t": ["system"] },
                ];
      send([
        "REQ",
        wire,
        ...filters.map((filter) => ({
          ...filter,
          // Each channel retains its original replay allowance. Replacements
          // are live-only on every actual dispatch, including cooldown retries.
          since: route.since,
          ...(route.id === "observer"
            ? {}
            : { limit: route.liveOnly ? 0 : LIVE_REPLAY_LIMIT }),
        })),
        ...(route.id === "membership"
          ? [
              {
                kinds: [30078],
                authors: [viewer],
                "#t": ["read-state"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
              // Edits from another device; history and due times come from the reader.
              {
                kinds: [30300],
                authors: [viewer],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
        ...(route.id === "profiles"
          ? [
              {
                kinds: [30315],
                "#d": ["general"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
              {
                kinds: [30030],
                "#d": [EMOJI_SET],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
      ]);
    }
  }
  function clearSocket() {
    generation++;
    authenticated = false;
    presenceReceipt?.finish(false);
    admission.setup(routes, false);
    clearTimeout(dispatchTimer);
    clearTimeout(recoveryTimer);
    clearTimeout(deadline);
    for (const route of routes.values()) clearTimeout(route.deadline);
    wires.clear();
    requests.clear();
    if (socket) log.info(`${peer} disconnect`);
    socket?.close();
    socket = undefined;
  }
  function connect() {
    if (closed) return;
    clearSocket();
    routes.clear();
    connection = "connecting";
    connectionError = undefined;
    sync();
    const current = generation;
    const valid = () => !closed && current === generation;
    const reconnect = (reason: string) => {
      if (!valid()) return;
      log.warn(`${peer} ${reason}`);
      clearSocket();
      connection = "retrying";
      connectionError = reason;
      for (const route of routes.values())
        if (route.status !== "limited") route.status = "pending";
      notify();
      // Transient outages must recover without manual retry. Equal jitter
      // spreads reconnects while retaining a minimum delay under sustained failure.
      const delay = reconnectDelay * (0.5 + Math.random() / 2);
      reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 2);
      retryTimer = setTimeout(connect, delay);
    };
    const terminal = (reason: string) => {
      if (!valid()) return;
      log.error(`${peer} ${reason}`);
      clearSocket();
      connection = "error";
      connectionError = reason;
      notify();
    };
    let ws: WebSocket;
    try {
      log.info(`${peer} connecting`);
      ws = socketFactory(url);
      socket = ws;
    } catch {
      reconnect("Live connection unavailable");
      return;
    }
    let authId: string | undefined;
    let authenticating = false;
    deadline = setTimeout(
      () => reconnect("Live authentication timed out"),
      10000,
    );
    ws.onopen = () => {
      if (valid()) log.info(`${peer} connected`);
    };
    ws.onmessage = async (event) => {
      if (!valid()) return;
      if (typeof event.data !== "string" || event.data.length > 1024 * 1024) {
        logSocketFrame(peer, "←", event.data);
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        logSocketFrame(peer, "←", event.data);
        return;
      }
      logSocketFrame(peer, "←", event.data, data);
      if (!Array.isArray(data)) return;
      if (
        data[0] === "AUTH" &&
        typeof data[1] === "string" &&
        !authenticating
      ) {
        authenticating = true;
        try {
          const auth = await sign({
            kind: 22242,
            content: "",
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", url],
              ["challenge", data[1]],
            ],
          });
          if (!valid()) return;
          if (auth.pubkey !== viewer) {
            terminal("Live signer does not match viewer");
            return;
          }
          authId = auth.id;
          send(["AUTH", auth]);
        } catch {
          terminal("Live authentication signing failed");
        }
        return;
      }
      if (data[0] === "OK" && authId && data[1] === authId && !authenticated) {
        if (data[2] !== true) {
          terminal("Relay rejected live authentication");
          return;
        }
        clearTimeout(deadline);
        authenticated = true;
        connection = "connected";
        recoveryTimer = setTimeout(recover, LIVE_RECOVERY_INTERVAL);
        pump();
        notify();
        return;
      }
      if (data[0] === "OK" && presenceReceipt?.id === data[1]) {
        if (
          data[2] === false &&
          typeof data[3] === "string" &&
          data[3].startsWith("rate-limited:")
        ) {
          const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
            data[3],
          );
          const seconds = hint ? Number(hint[1]) : 86400;
          admission.pause(
            Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
          );
        }
        presenceReceipt?.finish(data[2] === true);
        return;
      }
      if (authenticated && requests.receive(data)) {
        if (data[2] === false) {
          const reason = data[3];
          if (
            typeof reason === "string" &&
            reason.startsWith("rate-limited:")
          ) {
            const hint = /retry in (\d+)s$/.exec(reason);
            admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
          }
        }
        return;
      }
      const route =
        typeof data[1] === "string" ? wires.get(data[1]) : undefined;
      if (!authenticated || !route) return;
      const currentRoute = routes.get(route.id);
      const previous = currentRoute?.previous === route;
      if (currentRoute !== route && !previous) return;
      if (previous && data[0] !== "EVENT") {
        if (data[0] === "CLOSED") {
          closeWire(route);
          delete currentRoute.previous;
        }
        return;
      }
      if (data[0] === "EVENT") {
        let incoming: VerifiedEvent;
        try {
          incoming = eventDto(data[2]);
        } catch {
          fail(currentRoute ?? route, "Relay supplied invalid live traffic");
          return;
        }
        const ids = scope(route);
        const tags = incoming.tags.filter(([name]) => name === "h");
        const destination =
          tags.length === 1
            ? tags[0]?.[1]
            : !tags.length && [39000, 39002].includes(incoming.kind)
              ? incoming.tags.find(([name]) => name === "d")?.[1]
              : undefined;
        const channelId =
          destination && ids.includes(destination)
            ? destination
            : !tags.length && route.channelId
              ? route.channelId
              : undefined;
        if (
          ids.length &&
          tags.length &&
          !tags.some(([, id]) => id && ids.includes(id))
        )
          return;
        if (previous) {
          const retained = scope(currentRoute);
          // Untagged auxiliary events cannot inherit a narrowed scope. Preserve
          // the original source fence; the replacement can deliver fresh copies.
          if (
            channelId
              ? !retained.includes(channelId)
              : ids.some((id) => !retained.includes(id))
          )
            return;
        }
        // The session still verifies access and auxiliary target evidence.
        if (incoming.kind === 20002 && !channelId) return;
        if (route.status === "pending" && !route.liveOnly) route.count++;
        if (route.id === "presence") {
          if (
            incoming.kind === 20001 &&
            presenceAuthors.includes(incoming.pubkey)
          )
            callbacks.presence?.(incoming);
        } else if (route.id === "observer") {
          if (
            observer !== null &&
            incoming.kind === OBSERVER_KIND &&
            incoming.created_at >= route.since
          )
            callbacks.telemetry?.(incoming, observer);
        } else if (incoming.kind !== OBSERVER_KIND)
          callbacks.receive(
            [incoming],
            Object.freeze({
              phase:
                !route.historyParent &&
                (route.liveOnly || route.status === "live")
                  ? "live"
                  : "replay",
              ...(channelId
                ? { channelId }
                : ids.length
                  ? { sourceChannels: ids }
                  : {}),
            }),
          );
      } else if (data[0] === "EOSE" && route.status === "pending") {
        clearTimeout(route.deadline);
        if (route.historyParent) {
          const parent = routes.get(route.historyParent);
          remove(route);
          if (parent && parent.replayOffset !== undefined) {
            parent.replayOffset += scope(route).length;
            if (parent.error) {
              delete parent.error;
              notify();
            }
            if (
              route.count >= LIVE_REPLAY_LIMIT &&
              parent.replay !== "limited"
            ) {
              parent.replay = "limited";
              notify();
            }
          }
          if (valid()) pump();
          return;
        }
        if (route.previous) closeWire(route.previous);
        delete route.previous;
        route.status = "live";
        delete route.error;
        route.replay = route.count >= LIVE_REPLAY_LIMIT ? "limited" : "unknown";
        notify();
        if (!valid() || wires.get(route.wire ?? "") !== route) return;
        if (route.id !== "observer" && route.id !== "presence")
          callbacks.established(route.channelIds ?? route.channelId);
        if (valid()) pump();
      } else if (data[0] === "CLOSED") {
        const reason =
          typeof data[2] === "string"
            ? data[2].slice(0, 512)
            : "Relay closed live subscription";
        fail(
          route,
          reason,
          reason.startsWith("rate-limited:") || reason.startsWith("error:"),
        );
      }
    };
    ws.onerror = () => reconnect("Live connection interrupted");
    ws.onclose = () => reconnect("Live connection closed");
  }
  connect();
  return {
    watchPresence(authors) {
      const next = livePresenceAuthors(authors);
      if (closed || JSON.stringify(next) === JSON.stringify(presenceAuthors))
        return;
      presenceAuthors = next;
      const route = routes.get("presence");
      if (route) {
        if (next.length) replace(route);
        else remove(route);
      }
      sync();
    },
    async publishPresence(status, signal) {
      if (
        (status !== "online" && status !== "away" && status !== "offline") ||
        signal.aborted ||
        closed ||
        !authenticated
      )
        return null;
      const release = admission.tryPresence();
      // Busy alone is not a retry deadline; only actual gates get boundary retries.
      if (!release)
        return admission.presenceReady()
          ? null
          : { retryAfterMs: admission.presenceDelay() };
      const current = generation;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      try {
        const event = eventDto(
          await sign({
            kind: 20001,
            content: status,
            tags: [],
            created_at: Math.floor(Date.now() / 1000),
          }),
        );
        if (
          bounded.aborted ||
          closed ||
          current !== generation ||
          !authenticated ||
          socket?.readyState !== 1
        )
          return null;
        if (!admission.presenceReady())
          return { retryAfterMs: admission.presenceDelay() };
        if (
          event.pubkey !== viewer ||
          event.kind !== 20001 ||
          event.content !== status ||
          event.tags.length
        )
          throw new Error("Presence signer changed intent");
        return await new Promise<boolean>((resolve, reject) => {
          const finish = (accepted: boolean) => {
            clearTimeout(receiptTimeout);
            presenceReceipt = undefined;
            resolve(accepted);
          };
          // Once sent, retain the correlated receipt even if the caller leaves:
          // a late quota refusal still belongs to the shared host cooldown.
          const receiptTimeout = setTimeout(() => finish(false), 10000);
          presenceReceipt = { id: event.id, finish };
          try {
            admission.presenceSent();
            send(["EVENT", event]);
          } catch (error) {
            finish(false);
            reject(error);
          }
        });
      } finally {
        release();
      }
    },
    publish(event, signal) {
      if (closed)
        return Promise.reject(
          new SocketRequestError("Relay session disposed", false),
        );
      if (event.pubkey !== viewer)
        return Promise.reject(
          new SocketRequestError(
            "Publication signer does not match viewer",
            false,
          ),
        );
      return requests.publish(event, signal);
    },
    observe(value) {
      const next = observerGeneration(value);
      if (closed || observer === next) return;
      observer = next;
      const route = routes.get("observer");
      if (route) remove(route); // Fence the old wire before enabling a new generation.
      sync();
    },
    prioritize(input) {
      liveChannels(input); // Same bounded ID validation, but preserve demand order.
      priority = [...new Set(input)].slice(0, 64);
      if (!closed) sync();
    },
    update(input, batchable = []) {
      const next = liveChannels(input);
      const nextJoined = liveJoined(next, batchable);
      if (
        closed ||
        (JSON.stringify(next) === JSON.stringify(interests) &&
          JSON.stringify(nextJoined) === JSON.stringify(joined))
      )
        return;
      for (const id of denying ?? [])
        if (
          !next.includes(id) ||
          joined.includes(id) !== nextJoined.includes(id)
        )
          denying?.delete(id);
      interests = next;
      joined = nextJoined;
      sync();
    },
    retry() {
      if (closed) return;
      clearTimeout(retryTimer);
      reconnectDelay = BASE_RECONNECT_DELAY;
      if (authenticated) {
        for (const route of routes.values()) {
          if (route.status !== "error") continue;
          route.status = "pending";
          route.count = 0;
          route.quotaRetries = 0;
        }
        pump();
        notify();
      } else connect();
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearSocket();
      routes.clear();
    },
  };
}
