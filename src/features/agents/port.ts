// The agents service and the screens that use it can run in different pages.
// The service answers over a MessagePort; the client holds what screens read
// synchronously, as the service last pushed it, and sends everything else.
import type {
  Agent,
  AgentCreationRequest,
  Agents,
  AgentsClient,
  AgentsSnapshot,
  AgentUpdateRequest,
} from "./service";

/** Calls a screen waits for. Each takes and returns structured-cloneable data. */
const CALLS = [
  "create",
  "approveCreation",
  "approveUpdate",
  "finish",
  "portable",
  "port",
  "portTeam",
  "save",
  "retype",
  "remove",
  "forget",
  "join",
  "leave",
  "interrupt",
  "session",
  "unarchive",
  "setClassifierKey",
  "clearClassifierKey",
  "saveTeam",
  "removeTeam",
] as const satisfies readonly (keyof AgentsClient)[];
/** Calls a screen makes without waiting for an answer. */
const SENDS = [
  "resumeInterrupted",
  "dismissInterrupted",
  "dismissCreation",
  "dismissUpdate",
] as const satisfies readonly (keyof AgentsClient)[];
type Call = (typeof CALLS)[number];
type Send = (typeof SENDS)[number];

/** What screens read synchronously. */
type State = Readonly<{
  snapshot: AgentsSnapshot;
  memberships: Readonly<Record<string, ReturnType<Agents["memberships"]>>>;
  joinable: readonly Agent[];
  interruptible: readonly string[];
  creationRequests: readonly AgentCreationRequest[];
  updateRequests: readonly AgentUpdateRequest[];
}>;
type ToClient =
  | Readonly<{ kind: "state"; state: State }>
  | Readonly<{ kind: "result"; id: number; value: unknown }>
  | Readonly<{ kind: "error"; id: number; message: string }>;
type ToService =
  | Readonly<{ kind: "call"; id: number; method: Call; args: unknown[] }>
  | Readonly<{ kind: "send"; method: Send; args: unknown[] }>;

/** What the client carries of `AgentsClient` so far. Types, session state and
 * the retype preview call into plugin code, which a later change gives the
 * screens' page. */
export type AgentsPortClient = Omit<
  AgentsClient,
  "types" | "sessionState" | "previewRetype"
>;

function stateOf(agents: Agents): State {
  const snapshot = agents.snapshot();
  const memberships: Record<string, ReturnType<Agents["memberships"]>> = {};
  const joinable = agents.joinable();
  // Every agent a screen can show: listed, running, joinable or on a team.
  const shown = [
    ...[...snapshot.agents, ...snapshot.running, ...joinable].map(
      (agent) => agent.pubkey,
    ),
    ...snapshot.teams.flatMap((team) => team.members),
  ];
  for (const pubkey of shown)
    memberships[pubkey] ??= agents.memberships(pubkey);
  return {
    snapshot,
    memberships,
    joinable,
    interruptible: [
      ...new Set(
        snapshot.agents
          .filter((agent) => agents.interruptible(agent.pubkey))
          .map((agent) => agent.pubkey),
      ),
    ],
    creationRequests: agents.creationRequests(),
    updateRequests: agents.updateRequests(),
  };
}

/** Serves `agents` on `port` until the returned stop. It pushes state before
 * each answer, so a call's result never arrives before what it changed. */
export function serveAgents(agents: Agents, port: MessagePort) {
  let pending = true;
  const flush = () => {
    if (!pending) return;
    pending = false;
    port.postMessage({
      kind: "state",
      state: stateOf(agents),
    } satisfies ToClient);
  };
  // Several changes in one task are one push.
  const changed = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(flush);
  };
  const unsubscribe = agents.subscribe(changed);
  const calls = new Set<string>(CALLS);
  const sends = new Set<string>(SENDS);
  port.onmessage = ({ data }: MessageEvent<ToService>) => {
    if (data.kind === "send" && sends.has(data.method)) {
      (agents[data.method] as (...args: unknown[]) => void)(...data.args);
      return;
    }
    if (data.kind !== "call" || !calls.has(data.method)) return;
    const { id, method, args } = data;
    void (async () =>
      (agents[method] as (...args: unknown[]) => Promise<unknown>)(...args))()
      .then(
        (value): ToClient => ({ kind: "result", id, value }),
        (error: unknown): ToClient => ({
          kind: "error",
          id,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((answer) => {
        flush();
        port.postMessage(answer);
      });
  };
  flush();
  return () => {
    unsubscribe();
    port.onmessage = null;
    port.close();
  };
}

const EMPTY: readonly never[] = Object.freeze([]);
const STARTING: State = Object.freeze({
  snapshot: Object.freeze({
    status: "loading",
    classifier: "unavailable",
    classifierKey: "checking",
    agents: EMPTY,
    running: EMPTY,
    interrupted: EMPTY,
    teams: EMPTY,
  }),
  memberships: Object.freeze({}),
  joinable: EMPTY,
  interruptible: EMPTY,
  creationRequests: EMPTY,
  updateRequests: EMPTY,
});

/** `next`, keeping each part of `prior` it equals, so screens that compare by
 * identity see only what changed. Array items with a `key` match by it. */
export function shared<T>(prior: unknown, next: T): T {
  if (Object.is(prior, next) || typeof next !== "object" || next === null)
    return next;
  const before = prior;
  if (Array.isArray(next)) {
    const old = Array.isArray(before) ? (before as unknown[]) : [];
    const keyed = new Map(
      old.flatMap((item) => {
        const key = (item as { key?: unknown } | null)?.key;
        return typeof key === "string" ? [[key, item] as const] : [];
      }),
    );
    const items = next.map((item: unknown, index) => {
      const key = (item as { key?: unknown } | null)?.key;
      return shared(
        typeof key === "string" ? keyed.get(key) : old[index],
        item,
      );
    });
    return (
      Array.isArray(before) &&
      items.length === old.length &&
      items.every((item, index) => item === old[index])
        ? before
        : Object.freeze(items)
    ) as T;
  }
  const old =
    typeof before === "object" && before !== null && !Array.isArray(before)
      ? (before as Record<string, unknown>)
      : undefined;
  const entries = Object.entries(next).map(
    ([key, value]) => [key, shared(old?.[key], value)] as const,
  );
  return (
    old &&
    entries.length === Object.keys(old).length &&
    entries.every(([key, value]) => key in old && old[key] === value)
      ? old
      : Object.freeze(Object.fromEntries(entries))
  ) as T;
}

/** The agents served on `port`, for screens. Until the first push it reads
 * as loading. */
export function connectAgents(port: MessagePort) {
  let state = STARTING;
  let next = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  const waiting = new Map<
    number,
    Readonly<{ resolve(value: unknown): void; reject(error: Error): void }>
  >();
  port.onmessage = ({ data }: MessageEvent<ToClient>) => {
    if (data.kind === "state") {
      const prior = state;
      state = shared(prior, data.state);
      if (state !== prior) for (const listener of listeners) listener();
      return;
    }
    const pending = waiting.get(data.id);
    if (!pending) return;
    waiting.delete(data.id);
    if (data.kind === "result") pending.resolve(data.value);
    else pending.reject(new Error(data.message));
  };
  const post = (message: ToService) => {
    if (closed) throw new Error("The agents connection is closed.");
    port.postMessage(message);
  };
  const call =
    (method: Call) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, { resolve, reject });
        try {
          post({ kind: "call", id, method, args });
        } catch (error) {
          waiting.delete(id);
          reject(error);
        }
      });
  const send =
    (method: Send) =>
    (...args: unknown[]) => {
      // Screens pass these as event handlers; the event is not an argument.
      post({
        kind: "send",
        method,
        args: args.filter((arg) => !(arg instanceof Event)),
      });
    };
  const calls = Object.fromEntries(
    CALLS.map((method) => [method, call(method)]),
  );
  const sends = Object.fromEntries(
    SENDS.map((method) => [method, send(method)]),
  );
  const client = {
    ...calls,
    ...sends,
    snapshot: () => state.snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    find: (pubkey: string) =>
      state.snapshot.agents.find((agent) => agent.pubkey === pubkey),
    classifier: () => state.snapshot.classifier,
    memberships: (pubkey: string) => state.memberships[pubkey] ?? EMPTY,
    joinable: () => state.joinable,
    interruptible: (pubkey: string) => state.interruptible.includes(pubkey),
    creationRequests: () => state.creationRequests,
    updateRequests: () => state.updateRequests,
  } as AgentsPortClient;
  return Object.freeze({
    ...client,
    close() {
      if (closed) return;
      closed = true;
      port.onmessage = null;
      port.close();
      for (const pending of waiting.values())
        pending.reject(new Error("The agents connection is closed."));
      waiting.clear();
    },
  });
}
