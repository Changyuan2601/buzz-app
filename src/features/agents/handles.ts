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
