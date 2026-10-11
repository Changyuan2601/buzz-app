/** One agent this machine keeps, in any community. Names never grant control;
 * Agents2 owns its key and runtime. */
export type LocalAgent = Readonly<{
  pubkey: string;
  name: string;
  /** The community origin it was created for. */
  relayUrl: string;
  owner: string;
}>;
export type LocalAgentsSnapshot = Readonly<{
  status: "unavailable" | "loading" | "ready" | "error";
  agents: readonly LocalAgent[];
  error?: string;
}>;
export type LocalAgents = {
  snapshot(): LocalAgentsSnapshot;
  subscribe(listener: () => void): () => void;
};

const unavailable: LocalAgentsSnapshot = Object.freeze({
  status: "unavailable",
  agents: Object.freeze([]),
});

/** Names and mentions are composed before Agents2 exists; this lets them
 * follow its list once `bind` connects it. */
export function createLocalAgents() {
  let source: LocalAgents | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const agents: LocalAgents = {
    snapshot: () => source?.snapshot() ?? unavailable,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    agents,
    bind(next: LocalAgents) {
      source = next;
      const stop = next.subscribe(notify);
      notify();
      return () => {
        stop();
        if (source === next) source = undefined;
        notify();
      };
    },
  };
}
