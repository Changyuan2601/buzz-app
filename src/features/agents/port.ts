// The agents service and the screens that use it can run in different pages.
// The service answers over a port; the client holds what screens read
// synchronously, as the service last pushed it, and sends everything else.
import {
  type Agent,
  type AgentCreationRequest,
  type Agents,
  type AgentsClient,
  type AgentsSnapshot,
  type AgentUpdateRequest,
  retypePreview,
  type SessionPlace,
  type SessionState,
} from "./service";
import {
  serveTypes,
  type TypeCall,
  type TypesState,
  type TypeWatch,
  typesClient,
} from "./type-port";

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
  types: TypesState;
  /** Each session state a screen asked for, by `placeKey`. */
  sessions: Readonly<Record<string, SessionState>>;
}>;
type ToClient =
  | Readonly<{ kind: "state"; state: State }>
  | Readonly<{ kind: "result"; id: number; value: unknown }>
  | Readonly<{ kind: "error"; id: number; message: string }>;
type ToService =
  | Readonly<{ kind: "hello" }>
  | Readonly<{ kind: "call"; id: number; method: Call; args: unknown[] }>
  | Readonly<{ kind: "send"; method: Send; args: unknown[] }>
  | Readonly<{ kind: "type"; id: number; call: TypeCall; args: unknown[] }>
  | Readonly<{ kind: "watch"; watch: TypeWatch }>
  | Readonly<{ kind: "session"; key: string; place: SessionPlace }>
  | Readonly<{ kind: "abort"; signal: number }>;

/** A `MessagePort`, or a link to a page in another webview. It delivers each
 * message once, in the order sent. */
export type AgentsPort = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};

/** `AgentsClient`, and `present` for what this page shows of each type (by
 * type key). */
export type AgentsPortClient = AgentsClient &
  Readonly<{ present: ReturnType<typeof typesClient>["present"] }>;

const placeKey = (key: string, { channelId, root }: SessionPlace) =>
  JSON.stringify([key, channelId, root ?? ""]);

function stateOf(
  agents: Agents,
  types: TypesState,
  places: ReadonlyMap<string, readonly [string, SessionPlace]>,
): State {
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
    types,
    sessions: Object.fromEntries(
      [...places].map(([id, [key, place]]) => [
        id,
        agents.sessionState(key, place),
      ]),
    ),
  };
}

/** Serves `agents` on `port` until the returned stop. It pushes state before
 * each answer, so a call's result never arrives before what it changed. */
export function serveAgents(agents: Agents, port: AgentsPort) {
  const types = serveTypes(agents);
  const places = new Map<string, readonly [string, SessionPlace]>();
  // The types' own stores, which change without the service's notice.
  const stores = new Map<(listener: () => void) => () => void, () => void>();
  let pending = true;
  const flush = () => {
    if (!pending) return;
    pending = false;
    const wanted = new Set(types.stores());
    for (const [subscribe, stop] of stores)
      if (!wanted.has(subscribe)) {
        stop();
        stores.delete(subscribe);
      }
    for (const subscribe of wanted)
      if (!stores.has(subscribe)) stores.set(subscribe, subscribe(changed));
    port.postMessage({
      kind: "state",
      state: stateOf(agents, types.state(), places),
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
    // A screens' page that loaded after the last push needs one now.
    if (data.kind === "hello") {
      pending = true;
      flush();
      return;
    }
    if (data.kind === "send" && sends.has(data.method)) {
      (agents[data.method] as (...args: unknown[]) => void)(...data.args);
      return;
    }
    if (data.kind === "watch") {
      types.watch(data.watch);
      changed();
      return;
    }
    if (data.kind === "session") {
      places.set(placeKey(data.key, data.place), [data.key, data.place]);
      changed();
      return;
    }
    if (data.kind === "abort") {
      types.abort(data.signal);
      return;
    }
    if (data.kind === "type") {
      answer(data.id, () => types.call(data.call, data.args));
      return;
    }
    if (data.kind !== "call" || !calls.has(data.method)) return;
    const { id, method, args } = data;
    answer(id, () =>
      (agents[method] as (...args: unknown[]) => Promise<unknown>)(...args),
    );
  };
  function answer(id: number, run: () => unknown) {
    void (async () => run())()
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
  }
  flush();
  return () => {
    unsubscribe();
    for (const stop of stores.values()) stop();
    stores.clear();
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
  types: Object.freeze({
    types: EMPTY,
    values: Object.freeze({}),
    scopes: Object.freeze({}),
  }),
  sessions: Object.freeze({}),
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
export function connectAgents(port: AgentsPort) {
  let state = STARTING;
  let next = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  const asked = new Set<string>();
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
  // The service may have pushed before this page listened.
  post({ kind: "hello" });
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
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const types = typesClient(
    () => state.types,
    subscribe,
    {
      call: (call, args) =>
        new Promise((resolve, reject) => {
          const id = ++next;
          waiting.set(id, { resolve, reject });
          try {
            post({ kind: "type", id, call, args });
          } catch (error) {
            waiting.delete(id);
            reject(error);
          }
        }),
      watch: (watch) => {
        if (!closed) post({ kind: "watch", watch });
      },
      abort: (signal) => {
        if (!closed) post({ kind: "abort", signal });
      },
    },
    () => {
      for (const listener of listeners) listener();
    },
  );
  const sends = Object.fromEntries(
    SENDS.map((method) => [method, send(method)]),
  );
  const client = {
    ...calls,
    ...sends,
    snapshot: () => state.snapshot,
    subscribe,
    types: types.types,
    present: types.present,
    find: (pubkey: string) =>
      state.snapshot.agents.find((agent) => agent.pubkey === pubkey),
    classifier: () => state.snapshot.classifier,
    memberships: (pubkey: string) => state.memberships[pubkey] ?? EMPTY,
    joinable: () => state.joinable,
    interruptible: (pubkey: string) => state.interruptible.includes(pubkey),
    creationRequests: () => state.creationRequests,
    updateRequests: () => state.updateRequests,
    // A place reads as unavailable until the service has pushed it.
    sessionState: (key: string, place: SessionPlace) => {
      const id = placeKey(key, place);
      if (!asked.has(id) && !closed) {
        asked.add(id);
        post({ kind: "session", key, place });
      }
      return state.sessions[id] ?? "unavailable";
    },
    // The service's preview, from the agent's config and the types' config
    // functions, which both pages have.
    previewRetype: (key: string, type: string) => {
      const agent = state.snapshot.agents.find((item) => item.key === key);
      if (!agent) throw new Error("No such agent on this device");
      const kinds = types.types();
      const kind = kinds.find((item) => item.key === type);
      if (!kind) throw new Error("That agent type is not available");
      if (kind.remote)
        throw new Error("A hosted provider cannot take over a local agent key");
      if (type === agent.type)
        return { config: agent.config, moved: [], dropped: [], settings: [] };
      return retypePreview(
        agent.config,
        kinds.find((item) => item.key === agent.type),
        kind,
      );
    },
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
