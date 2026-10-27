// Agent presence: the Runner tells each community which agents this copy of
// the app runs there. It is the Runner's, as it knows what runs.
import type { RelaySession } from "../relay/session";

/** How often agents are said to be online; the relay keeps it 180 seconds. */
const PRESENCE_MS = 60_000;
/** How soon a failed presence is sent again. */
const RETRY_MS = 30_000;
/** The most agents one presence event names. */
const PRESENCE_BATCH = 256;

/** A community's live connection, while it has one. */
export type PresenceConnection = Readonly<{
  session: RelaySession;
  controller: AbortController;
}>;
export type PresenceHost = Readonly<{
  /** By origin, the pubkeys of the agents this copy runs there. */
  running(): ReadonlyMap<string, ReadonlySet<string>>;
  /** Each community an agent is in, by origin, with its live connection. */
  communities(): Iterable<readonly [string, PresenceConnection | undefined]>;
  /** Another copy of the app took over the agent's membership there. */
  yielded(origin: string, pubkey: string): boolean;
}>;

export class AgentPresence {
  /** By origin: the agents last said to be online there, and when. */
  private readonly sent = new Map<
    string,
    {
      session: RelaySession;
      online: ReadonlySet<string>;
      at: number;
      /** The session cannot send presence, so it is not tried again. */
      unable?: boolean;
    }
  >();
  /** Origins whose presence is being sent. */
  private readonly announcing = new Set<string>();

  constructor(private readonly host: PresenceHost) {}

  /** Tells each community which agents this copy runs there: online every
   * minute while it does, and offline once it stops, unless another copy took
   * over. Offline is best effort; the relay lets a lapsed online expire. */
  announce() {
    const online = this.host.running();
    const communities = new Map(this.host.communities());
    for (const origin of this.sent.keys())
      if (!communities.has(origin)) this.sent.delete(origin);
    const now = Date.now();
    for (const [origin, binding] of communities) {
      if (!binding || this.announcing.has(origin)) continue;
      const next = online.get(origin) ?? new Set<string>();
      const prior = this.sent.get(origin);
      const same = prior?.session === binding.session;
      if (same && prior.unable) continue;
      // Another copy that took an agent over says it is online; offline from
      // this one could arrive after that, so forget it was online here.
      const was = new Set(
        [...(prior?.online ?? [])].filter(
          (pubkey) => next.has(pubkey) || !this.host.yielded(origin, pubkey),
        ),
      );
      if (prior && was.size < prior.online.size)
        this.sent.set(origin, { ...prior, online: was });
      const gone = [...was].filter((pubkey) => !next.has(pubkey));
      const due = !same || now - prior.at >= PRESENCE_MS;
      const changed =
        gone.length > 0 || [...next].some((pubkey) => !was.has(pubkey));
      if (!changed && (!due || !next.size)) continue;
      this.announcing.add(origin);
      const sent = { session: binding.session, online: next, at: now };
      this.sent.set(origin, sent);
      void (async () => {
        for (const [status, agents] of [
          ["offline", gone],
          ["online", [...next]],
        ] as const)
          for (let at = 0; at < agents.length; at += PRESENCE_BATCH)
            if (
              !(await binding.session.publishAgentPresence(
                status,
                agents.slice(at, at + PRESENCE_BATCH),
                binding.controller.signal,
              ))
            )
              return false;
        return true;
      })()
        .then((ok) => {
          if (ok || this.sent.get(origin) !== sent) return;
          console.warn("Agent presence cannot be sent on this connection");
          this.sent.set(origin, { ...sent, unable: true });
        })
        .catch((error) => {
          if (binding.controller.signal.aborted) return;
          console.warn("Agent presence was not sent", error);
          // Try again sooner than the minute, but not every tick.
          if (this.sent.get(origin) === sent)
            this.sent.set(origin, {
              ...sent,
              at: Date.now() - PRESENCE_MS + RETRY_MS,
            });
        })
        .finally(() => this.announcing.delete(origin));
    }
  }

  /** Forgets what was sent, as the app stops. */
  clear() {
    this.sent.clear();
  }
}
