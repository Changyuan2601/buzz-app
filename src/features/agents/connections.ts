// The Runner's own connections: the live session of each community it runs
// agents in, and the listener that hears that community's events for them.
// The Manager keeps its own connections for listings and cleanup.
import { communityDestination } from "../communities/destination";
import { relayPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { AgentIdentity } from "./native";
import type { Connection } from "./runner";

/** A community's session while it is live, as the Runner's agents use it. */
export type RunnerBinding = Readonly<{
  scope: string;
  origin: string;
  viewer: string;
  session: RelaySession;
  /** Aborts when this binding is replaced, so no work outlives its session. */
  controller: AbortController;
  connection: Connection;
  stopLive: () => void;
}>;
/** The origin a relay URL or community ID names, if it is a valid one. */
export const originOf = (value: string) => {
  try {
    return communityDestination(value).url;
  } catch {
    return undefined;
  }
};

type Entry = {
  relay: RelayData;
  stop: () => void;
  binding?: RunnerBinding | undefined;
};

export type ConnectionsHost = Readonly<{
  /** The community's relay, while the viewer is in it. */
  open(origin: string): RelayData | undefined;
  /** Hears the live session's events until the returned stop. */
  listen(
    session: RelaySession,
    origin: string,
    connection: Connection,
  ): () => void;
  /** The community's live session started, was replaced or ended. */
  changed(origin: string): void;
}>;

export class RunnerConnections {
  private readonly bound = new Map<string, Entry>();

  constructor(private readonly host: ConnectionsHost) {}

  /** Connects each community where the viewer has an agent; lets go of the
   * rest. */
  watch(identities: readonly AgentIdentity[], viewer: string | undefined) {
    const origins = new Set<string>();
    for (const identity of identities) {
      const origin =
        !identity.deleted &&
        identity.owner === viewer &&
        originOf(identity.relay);
      if (origin) origins.add(origin);
    }
    // Left, or left and joined again with a new session.
    for (const [origin, entry] of this.bound)
      if (!origins.has(origin) || this.host.open(origin) !== entry.relay)
        this.unbind(origin);
    for (const origin of origins) {
      if (this.bound.has(origin)) continue;
      const relay = this.host.open(origin);
      if (!relay) continue;
      this.bound.set(origin, {
        relay,
        stop: relay.subscribe(() => this.bind(origin)),
      });
      this.bind(origin);
    }
  }
  /** The live binding of the agent's community, if it has one now. */
  binding({ relay, owner }: Pick<AgentIdentity, "relay" | "owner">) {
    const origin = originOf(relay);
    const binding = origin ? this.bound.get(origin)?.binding : undefined;
    return binding?.scope === relayPartition(origin ?? "", owner)
      ? binding
      : undefined;
  }
  /** The community's relay, while the Runner is connected to it. */
  relay(origin: string | undefined) {
    return origin ? this.bound.get(origin)?.relay : undefined;
  }
  /** Each community with its live binding, if it has one. */
  entries() {
    return [...this.bound].map(
      ([origin, entry]) => [origin, entry.binding] as const,
    );
  }
  clear() {
    for (const origin of [...this.bound.keys()]) this.unbind(origin);
  }

  private unbind(origin: string) {
    const entry = this.bound.get(origin);
    this.bound.delete(origin);
    entry?.stop();
    entry?.binding?.stopLive();
    entry?.binding?.controller.abort();
  }
  private bind(origin: string) {
    const entry = this.bound.get(origin);
    if (!entry) return;
    const snapshot = entry.relay.snapshot();
    const live =
      snapshot.status === "ready" &&
      !snapshot.cached &&
      snapshot.scope &&
      snapshot.origin &&
      snapshot.viewer
        ? {
            scope: snapshot.scope,
            origin: snapshot.origin,
            viewer: snapshot.viewer,
            session: snapshot.session,
            controller: new AbortController(),
          }
        : undefined;
    if (
      entry.binding?.session === live?.session &&
      entry.binding?.scope === live?.scope
    )
      return;
    entry.binding?.stopLive();
    entry.binding?.controller.abort();
    const connection: Connection = {
      epoch: 0,
      start: Math.floor(Date.now() / 1000),
    };
    entry.binding = live && {
      ...live,
      connection,
      stopLive: this.host.listen(live.session, origin, connection),
    };
    this.host.changed(origin);
  }
}
