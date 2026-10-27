// Handles a type's runtime exposes to its screens. Each is JSON, a store
// (`snapshot` and `subscribe`), a call returning a promise, or a keyed read,
// so that screens can later reach them from another page.
import { shared } from "./port";

/** A synchronous read by key, such as one agent's sessions, that screens use
 * as a store: `useSyncExternalStore(subscribe, () => read(key))`. Equal content
 * keeps its identity. Across pages a key reads as `empty` until it arrives. */
export type KeyedRead<T> = Readonly<{
  read(key: string): T;
  subscribe(listener: () => void): () => void;
  empty: T;
}>;

export function keyedRead<T>(
  read: (key: string) => T,
  subscribe: (listener: () => void) => () => void,
  empty: T,
): KeyedRead<T> {
  const last = new Map<string, T>();
  return Object.freeze({
    read(key: string) {
      const value = shared(last.get(key), read(key));
      last.set(key, value);
      return value;
    },
    subscribe,
    empty,
  });
}

/** `object`'s methods `names` as a plain handle, so a type exposes only what
 * its screens reach. Each calls `object` when called. */
export function handle<T extends object, K extends keyof T & string>(
  object: T,
  names: readonly K[],
): Readonly<Pick<T, K>> {
  return Object.freeze(
    Object.fromEntries(
      names.map((name) => [
        name,
        (...args: unknown[]) =>
          (object[name] as (...args: unknown[]) => unknown).apply(object, args),
      ]),
    ),
  ) as Pick<T, K>;
}

/** Members a screen reads synchronously: a store's and a keyed read's. */
const SYNC = new Set(["snapshot", "subscribe", "read", "empty"]);

/** An exposed handle as screens get it: each call returns a promise. Stores
 * and keyed reads stay synchronous. */
export type Remote<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object
    ? {
        readonly [K in keyof T]: K extends
          | "snapshot"
          | "subscribe"
          | "read"
          | "empty"
          ? T[K]
          : Remote<T[K]>;
      }
    : T;

/** `exposed` as screens in this page get it: what they will get from another
 * page. Calls return promises; handles must be plain objects, arrays or JSON. */
export function local<T>(exposed: T): Remote<T> {
  return localOf(exposed, "expose") as Remote<T>;
}

function localOf(value: unknown, path: string): unknown {
  if (typeof value === "function")
    return (...args: unknown[]) => {
      try {
        return Promise.resolve(value(...args));
      } catch (error) {
        return Promise.reject(error);
      }
    };
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value))
    return Object.freeze(
      value.map((item, index) => localOf(item, `${path}[${index}]`)),
    );
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(
      `${path} is not a plain object; expose a handle of what screens reach`,
    );
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        SYNC.has(key) ? member : localOf(member, `${path}.${key}`),
      ]),
    ),
  );
}
