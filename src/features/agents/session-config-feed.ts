// Adapts the relay session's live config routes to `ConfigFeed`: one shared
// scope for every open subscription, events dispatched by filter, and a new
// generation whenever the session reports that config traffic may have gapped.
import type { VerifiedEvent } from "nostr-tools";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { isConfigRoute, type LiveSnapshot } from "../relay/live";
import type { SnapshotRead } from "./agent-config-artifacts";
import type { ConfigFeed } from "./config-sync";

export type ConfigSession = Readonly<{
  snapshotRead?: SnapshotRead | undefined;
  relayAuthor?: string | undefined;
  live: Readonly<{
    snapshot(): LiveSnapshot;
    subscribe(listener: () => void): () => void;
  }>;
  configScope(scope: Readonly<{ channels: readonly string[] }> | null): void;
  onConfig(listener: (event: VerifiedEvent) => void): () => void;
  configGeneration(): number;
}>;

type Subscription = {
  filters: readonly ReadFilter[];
  handlers: Parameters<ConfigFeed["subscribe"]>[1];
  /** The generation this subscription last reported, by `eose` or `closed`. */
  reported?: number;
};

const SCOPE_TAGS = ["#h", "#d"] as const;

/** Live config filters use only these keys; anything else would be ignored
 * silently, so it is refused instead. */
const FILTER_KEYS = new Set(["kinds", "authors", "ids", "limit"]);

function supported(filter: ReadFilter) {
  for (const key of Object.keys(filter))
    if (!FILTER_KEYS.has(key) && !key.startsWith("#"))
      throw new Error(`Unsupported config filter key: ${key}`);
}

function matches(filter: ReadFilter, event: RelayEvent) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  return Object.entries(filter).every(
    ([key, values]) =>
      !key.startsWith("#") ||
      !Array.isArray(values) ||
      event.tags.some(
        ([name, value]) =>
          `#${name}` === key && value !== undefined && values.includes(value),
      ),
  );
}

/** Null when the session can't read or has no relay key (signed out). */
export function sessionConfigFeed(
  session: ConfigSession,
): (ConfigFeed & { dispose(): void }) | null {
  const { snapshotRead, relayAuthor } = session;
  if (!snapshotRead || !relayAuthor) return null;
  const subscriptions = new Set<Subscription>();
  const connections = new Set<(generation: number) => void>();
  let announced = session.configGeneration();
  let scoped = "null";

  function rescope() {
    const channels = [
      ...new Set(
        [...subscriptions].flatMap(({ filters }) =>
          filters.flatMap((filter) =>
            SCOPE_TAGS.flatMap((tag) => filter[tag] ?? []),
          ),
        ),
      ),
    ].sort();
    const scope = subscriptions.size ? { channels } : null;
    const key = JSON.stringify(scope);
    if (key === scoped) return;
    scoped = key;
    session.configScope(scope);
  }

  /** Report the current generation to every subscription once all config
   * routes settle, and announce a new connection when the generation moved. */
  function settle() {
    const generation = session.configGeneration();
    const snapshot = session.live.snapshot();
    const routes = snapshot.routes.filter((route) => isConfigRoute(route.id));
    if (!subscriptions.size || !routes.length) return;
    const failed = routes.find((route) => route.status === "error");
    if (failed) {
      for (const subscription of subscriptions)
        if (subscription.reported !== generation) {
          subscription.reported = generation;
          subscription.handlers.closed(
            generation,
            failed.error ?? "Config route closed",
          );
        }
      return;
    }
    if (
      snapshot.status !== "connected" ||
      !routes.every((route) => route.status === "live")
    )
      return;
    if (generation !== announced) {
      announced = generation;
      for (const listener of connections) listener(generation);
    }
    for (const subscription of subscriptions)
      if (subscription.reported !== generation) {
        subscription.reported = generation;
        subscription.handlers.eose(generation);
      }
  }

  const stops = [
    session.live.subscribe(settle),
    session.onConfig((event) => {
      for (const { filters, handlers } of [...subscriptions])
        if (filters.some((filter) => matches(filter, event)))
          handlers.event(event);
    }),
  ];

  return {
    read: snapshotRead,
    relayAuthor,
    generation: () => session.configGeneration(),
    connection(listener) {
      connections.add(listener);
      return () => {
        connections.delete(listener);
      };
    },
    subscribe(filters, handlers) {
      for (const filter of filters) supported(filter);
      const subscription: Subscription = { filters, handlers };
      subscriptions.add(subscription);
      rescope();
      queueMicrotask(settle);
      return () => {
        if (!subscriptions.delete(subscription)) return;
        rescope();
      };
    },
    dispose() {
      for (const stop of stops) stop();
      subscriptions.clear();
      connections.clear();
      rescope();
    },
  };
}
