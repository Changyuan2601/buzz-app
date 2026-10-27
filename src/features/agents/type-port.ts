// Agent types across the agents port. The service describes each type as
// data: what it is, which calls it answers, and the shape of what it exposes
// to its screens. The screens' side builds the type from that and from what
// its own page presents, as the service merges them in one page.
import { local } from "./handles";
import {
  type AgentPresentation,
  type AgentProviderSnapshot,
  type AgentType,
  type AgentTypeView,
  type Agents,
  presented,
} from "./service";

/** The shape of a type's `expose`; functions become calls by path. */
type Shape =
  | Readonly<{ kind: "value"; value: unknown }>
  | Readonly<{ kind: "call" }>
  | Readonly<{ kind: "snapshot" }>
  | Readonly<{ kind: "subscribe" }>
  | Readonly<{ kind: "read"; empty: unknown }>
  | Readonly<{ kind: "array"; items: readonly Shape[] }>
  | Readonly<{ kind: "object"; members: Readonly<Record<string, Shape>> }>;

/** What of a type does not change while it is registered. */
export type TypeDescriptor = Readonly<{
  key: string;
  pluginId: string;
  revision: string;
  id: string;
  title: string;
  description?: string;
  /** Its `defaults()`, for screens whose page presents none. */
  defaults: ReturnType<AgentType["defaults"]>;
  migrationWarning?: string;
  remote: boolean;
  models: boolean;
  usage: boolean;
  sessionControls: boolean;
  provider: boolean;
  /** Absent when it exposes nothing; `invalid` when what it exposes is not
   * plain handles, so it is not shown. */
  exposed?: Shape | "invalid";
}>;
/** What of a type screens read synchronously, as it is now. */
export type TypeValues = Readonly<{
  provider?: Readonly<{ snapshot: AgentProviderSnapshot; attention: boolean }>;
  /** Each exposed store's snapshot, by path. */
  snapshots: Readonly<Record<string, unknown>>;
  /** Each keyed read a screen asked for, by path and key. */
  reads: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;
export type TypesState = Readonly<{
  types: readonly TypeDescriptor[];
  values: Readonly<Record<string, TypeValues>>;
  /** Each shown agent's session scope, for types with session controls. */
  scopes: Readonly<Record<string, "thread" | "channel">>;
}>;
/** A call on a type: one of its own, or an exposed one by path. */
export type TypeCall = Readonly<{
  type: string;
  target:
    | "models"
    | "usage"
    | "check"
    | "attention"
    | Readonly<{ path: string }>;
}>;
export type TypeWatch = Readonly<{ type: string; path: string; key: string }>;

/** Stands in for an AbortSignal argument; `abort` messages name it. */
const SIGNAL = "$abortSignal";

type Described = Readonly<{
  shape: Shape | "invalid";
  calls: ReadonlyMap<string, (...args: unknown[]) => unknown>;
  snapshots: ReadonlyMap<string, () => unknown>;
  subscribes: readonly ((listener: () => void) => () => void)[];
  reads: ReadonlyMap<string, (key: string) => unknown>;
}>;

function describe(exposed: unknown): Described {
  const calls = new Map<string, (...args: unknown[]) => unknown>();
  const snapshots = new Map<string, () => unknown>();
  const subscribes: ((listener: () => void) => () => void)[] = [];
  const reads = new Map<string, (key: string) => unknown>();
  const walk = (value: unknown, path: string, name: string): Shape => {
    if (typeof value === "function") {
      const fn = value as (...args: unknown[]) => unknown;
      if (name === "snapshot") {
        snapshots.set(path, fn as () => unknown);
        return { kind: "snapshot" };
      }
      if (name === "subscribe") {
        subscribes.push(fn as (listener: () => void) => () => void);
        return { kind: "subscribe" };
      }
      if (name === "read") {
        reads.set(path, fn as (key: string) => unknown);
        return { kind: "read", empty: undefined };
      }
      calls.set(path, fn);
      return { kind: "call" };
    }
    if (typeof value !== "object" || value === null)
      return { kind: "value", value };
    if (Array.isArray(value))
      return {
        kind: "array",
        items: value.map((item, index) => walk(item, `${path}.${index}`, "")),
      };
    const members = Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        walk(member, `${path}.${key}`, key),
      ]),
    );
    if (members.read?.kind === "read")
      members.read = {
        kind: "read",
        empty: (value as { empty?: unknown }).empty,
      };
    return { kind: "object", members };
  };
  try {
    // The same check screens in the service's page get.
    local(exposed);
  } catch (error) {
    console.error("An agent type's handles cannot reach its screens", error);
    return { shape: "invalid", calls, snapshots, subscribes, reads };
  }
  return { shape: walk(exposed, "", ""), calls, snapshots, subscribes, reads };
}

/** Serves `agents`' types: their state for each push, the stores a push
 * waits on, and their calls. */
export function serveTypes(agents: Agents) {
  const described = new WeakMap<object, Described>();
  const describedOf = (exposed: unknown) => {
    if (typeof exposed !== "object" || exposed === null)
      return describe(exposed);
    let known = described.get(exposed);
    if (!known) {
      known = describe(exposed);
      described.set(exposed, known);
    }
    return known;
  };
  const watched = new Map<string, Map<string, Set<string>>>();
  const signals = new Map<number, AbortController>();
  const typeOf = (key: string) =>
    agents.types().find((type) => type.key === key);

  function state(): TypesState {
    const types = agents.types();
    const values: Record<string, TypeValues> = {};
    const scopes: Record<string, "thread" | "channel"> = {};
    const descriptors = types.map((type): TypeDescriptor => {
      const exposed =
        type.expose === undefined ? undefined : describedOf(type.expose);
      const reads: Record<string, Record<string, unknown>> = {};
      for (const [path, keys] of watched.get(type.key) ?? []) {
        const read = exposed?.reads.get(path);
        if (read)
          reads[path] = Object.fromEntries(
            [...keys].map((key) => [key, read(key)]),
          );
      }
      values[type.key] = {
        ...(type.provider && {
          provider: {
            snapshot: type.provider.snapshot(),
            attention: Boolean(type.provider.attentionAction),
          },
        }),
        snapshots: Object.fromEntries(
          [...(exposed?.snapshots ?? [])].map(([path, read]) => [path, read()]),
        ),
        reads,
      };
      return {
        key: type.key,
        pluginId: type.pluginId,
        revision: type.revision,
        id: type.id,
        title: type.title,
        ...(type.description !== undefined && {
          description: type.description,
        }),
        defaults: type.defaults(),
        ...(type.migrationWarning !== undefined && {
          migrationWarning: type.migrationWarning,
        }),
        remote: Boolean(type.remote),
        models: Boolean(type.models),
        usage: Boolean(type.usage),
        sessionControls: Boolean(type.sessionControls),
        provider: Boolean(type.provider),
        ...(exposed && { exposed: exposed.shape }),
      };
    });
    for (const agent of agents.snapshot().agents) {
      const controls = types.find(
        (type) => type.key === agent.type,
      )?.sessionControls;
      if (controls) scopes[agent.key] = controls.scope(agent);
    }
    return { types: descriptors, values, scopes };
  }

  /** Every store a push reads, so a change to any of them is pushed. */
  function stores() {
    const subscribes: ((listener: () => void) => () => void)[] = [];
    for (const type of agents.types()) {
      if (type.provider) subscribes.push(type.provider.subscribe);
      if (type.sessionControls) subscribes.push(type.sessionControls.subscribe);
      if (type.expose !== undefined)
        subscribes.push(...describedOf(type.expose).subscribes);
    }
    return subscribes;
  }

  function watch({ type, path, key }: TypeWatch) {
    const paths = watched.get(type) ?? new Map<string, Set<string>>();
    watched.set(type, paths);
    const keys = paths.get(path) ?? new Set<string>();
    paths.set(path, keys);
    keys.add(key);
  }

  const withSignals = (value: unknown, controllers: number[]): unknown => {
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value))
      return value.map((item) => withSignals(item, controllers));
    if (Object.keys(value).length === 1 && SIGNAL in value) {
      const id = (value as Record<typeof SIGNAL, number>)[SIGNAL];
      const controller = new AbortController();
      signals.set(id, controller);
      controllers.push(id);
      return controller.signal;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        withSignals(member, controllers),
      ]),
    );
  };

  async function call({ type: key, target }: TypeCall, raw: unknown[]) {
    const type = typeOf(key);
    if (!type) throw new Error("That agent type is not available");
    const controllers: number[] = [];
    const args = raw.map((arg) => withSignals(arg, controllers));
    try {
      const run = (): unknown => {
        if (target === "models")
          return type.models?.(
            ...(args as Parameters<NonNullable<AgentType["models"]>>),
          );
        if (target === "usage")
          return type.usage?.(
            ...(args as Parameters<NonNullable<AgentType["usage"]>>),
          );
        if (target === "check") return type.provider?.check();
        if (target === "attention") return type.provider?.attentionAction?.();
        const fn =
          type.expose === undefined
            ? undefined
            : describedOf(type.expose).calls.get(target.path);
        if (!fn) throw new Error("That agent type has no such call");
        return fn(...args);
      };
      return await run();
    } finally {
      for (const id of controllers) signals.delete(id);
    }
  }

  return {
    state,
    stores,
    watch,
    call,
    abort: (id: number) => signals.get(id)?.abort(),
  };
}

type Presentation = (exposed: unknown) => AgentPresentation;
const CHECKING: AgentProviderSnapshot = Object.freeze({
  readiness: "checking",
});
const NONE: TypeValues = Object.freeze({
  snapshots: Object.freeze({}),
  reads: Object.freeze({}),
});

/** The types on the screens' side, from what the service pushes and what this
 * page presents. `call` sends a type call, `watch` asks for a keyed read, and
 * `subscribe` is the client's own change notice. */
export function typesClient(
  current: () => TypesState,
  subscribe: (listener: () => void) => () => void,
  send: Readonly<{
    call(call: TypeCall, args: unknown[]): Promise<unknown>;
    watch(watch: TypeWatch): void;
    abort(id: number): void;
  }>,
  changed: () => void,
) {
  const presentations = new Map<string, Presentation>();
  const built = new Map<
    string,
    Readonly<{
      descriptor: TypeDescriptor;
      presentation: Presentation | undefined;
      view: AgentTypeView;
    }>
  >();
  let last:
    | Readonly<{
        types: readonly TypeDescriptor[];
        version: number;
        result: readonly AgentTypeView[];
      }>
    | undefined;
  let version = 0;
  let signals = 0;
  const watching = new Set<string>();

  const values = (key: string) => current().values[key] ?? NONE;
  /** Arguments as they cross: an AbortSignal becomes a stand-in, and its
   * abort is sent. */
  const crossing = (value: unknown): unknown => {
    if (value instanceof AbortSignal) {
      const id = ++signals;
      if (value.aborted) queueMicrotask(() => send.abort(id));
      else
        value.addEventListener("abort", () => send.abort(id), { once: true });
      return { [SIGNAL]: id };
    }
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map(crossing);
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, crossing(member)]),
    );
  };
  const call =
    (type: string, target: TypeCall["target"]) =>
    (...args: unknown[]) =>
      send.call({ type, target }, args.map(crossing));

  function proxy(type: string, shape: Shape, path: string): unknown {
    switch (shape.kind) {
      case "value":
        return shape.value;
      case "call":
        return call(type, { path });
      case "snapshot":
        return () => values(type).snapshots[path];
      case "subscribe":
        return subscribe;
      case "read": {
        const { empty } = shape;
        return (key: string) => {
          const id = JSON.stringify([type, path, key]);
          if (!watching.has(id)) {
            watching.add(id);
            send.watch({ type, path, key });
          }
          const reads = values(type).reads[path];
          return reads && key in reads ? reads[key] : empty;
        };
      }
      case "array":
        return Object.freeze(
          shape.items.map((item, index) =>
            proxy(type, item, `${path}.${index}`),
          ),
        );
      case "object":
        return Object.freeze(
          Object.fromEntries(
            Object.entries(shape.members).map(([key, member]) => [
              key,
              proxy(type, member, `${path}.${key}`),
            ]),
          ),
        );
    }
  }

  function view(descriptor: TypeDescriptor): AgentTypeView {
    const { key } = descriptor;
    const type = {
      key,
      pluginId: descriptor.pluginId,
      revision: descriptor.revision,
      id: descriptor.id,
      title: descriptor.title,
      ...(descriptor.description !== undefined && {
        description: descriptor.description,
      }),
      defaults: () => descriptor.defaults,
      ...(descriptor.migrationWarning !== undefined && {
        migrationWarning: descriptor.migrationWarning,
      }),
      ...(descriptor.remote && { remote: Object.freeze({}) }),
      ...(descriptor.models && { models: call(key, "models") }),
      ...(descriptor.usage && { usage: call(key, "usage") }),
      ...(descriptor.sessionControls && {
        sessionControls: Object.freeze({
          scope: (agent: { key: string }) =>
            current().scopes[agent.key] ?? "thread",
          subscribe,
        }),
      }),
      ...(descriptor.provider && {
        provider: Object.freeze({
          snapshot: () => values(key).provider?.snapshot ?? CHECKING,
          subscribe,
          check: call(key, "check"),
          get attentionAction() {
            return values(key).provider?.attention
              ? () => void call(key, "attention")()
              : undefined;
          },
        }),
      }),
    };
    return type as unknown as AgentTypeView;
  }

  function types(): readonly AgentTypeView[] {
    const descriptors = current().types;
    if (last?.types === descriptors && last.version === version)
      return last.result;
    const result = Object.freeze(
      descriptors.map((descriptor) => {
        const presentation = presentations.get(descriptor.key);
        const known = built.get(descriptor.key);
        if (
          known?.descriptor === descriptor &&
          known.presentation === presentation
        )
          return known.view;
        let shown = view(descriptor);
        if (presentation && descriptor.exposed !== "invalid") {
          try {
            const exposed =
              descriptor.exposed === undefined
                ? undefined
                : proxy(descriptor.key, descriptor.exposed, "");
            shown = presented(
              shown as unknown as AgentType,
              presentation(exposed),
            ) as unknown as AgentTypeView;
          } catch (error) {
            // Its agents still run; only what the type shows is missing.
            console.error(
              `Agent type ${descriptor.key} could not be shown`,
              error,
            );
          }
        }
        const frozen = Object.freeze(shown);
        built.set(descriptor.key, { descriptor, presentation, view: frozen });
        return frozen;
      }),
    );
    last = { types: descriptors, version, result };
    return result;
  }

  return {
    types,
    /** Supplies what type `key` shows, from this page, until the returned
     * stop; as `Agents.present` does where the service runs. */
    present(key: string, present: Presentation) {
      if (typeof present !== "function")
        throw new Error("present needs a function");
      presentations.set(key, present);
      version++;
      changed();
      return () => {
        if (presentations.get(key) !== present) return;
        presentations.delete(key);
        version++;
        changed();
      };
    },
  };
}
