/** Host-owned, device-local shortcut rebinds. Never depends on plugin/relay readiness. */
import { isKeyBinding, type KeyBinding } from "./bindings";

export const SHORTCUT_BINDINGS_KEY = "buzz-shortcut-bindings.v1";
export type ShortcutOverrides = Readonly<Record<string, KeyBinding>>;
export interface ShortcutBindingsSnapshot {
  readonly overrides: ShortcutOverrides;
  readonly error: string | null;
}

const RESTORE_ERROR =
  "Custom shortcuts could not be restored. Defaults are active; change a shortcut to try saving again.";
const SAVE_ERROR =
  "Your shortcuts are active, but could not be saved on this device. Try again.";

const freezeBinding = ({
  key,
  mod,
  ctrl,
  shift,
  alt,
}: KeyBinding): KeyBinding =>
  Object.freeze({
    key,
    ...(mod !== undefined && { mod }),
    ...(ctrl !== undefined && { ctrl }),
    ...(shift !== undefined && { shift }),
    ...(alt !== undefined && { alt }),
  });
/**
 * Keys are host ids and contribution keys chosen elsewhere, so the record has
 * no prototype: `overrides.constructor` is a stored binding or undefined, never
 * Object.prototype's function.
 */
const freezeOverrides = (
  entries: Iterable<readonly [string, KeyBinding]>,
): ShortcutOverrides => {
  const overrides: Record<string, KeyBinding> = Object.create(null);
  for (const [key, binding] of entries) overrides[key] = freezeBinding(binding);
  return Object.freeze(overrides);
};
const NO_OVERRIDES = freezeOverrides([]);

/** Keeps every well-formed entry and drops only malformed ones. */
export function parseOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return NO_OVERRIDES;
  return freezeOverrides(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, KeyBinding] =>
        entry[0].length > 0 && isKeyBinding(entry[1]),
    ),
  );
}

export function createShortcutBindings(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let state: ShortcutBindingsSnapshot = {
    overrides: NO_OVERRIDES,
    error: null,
  };
  // What the dispatcher reads on every keydown: one frozen alias list per key,
  // built once per change so matching never allocates and a Map lookup never
  // reaches an inherited property.
  let resolved: ReadonlyMap<string, readonly KeyBinding[]> = new Map();
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: ShortcutBindingsSnapshot) => {
    state = next;
    resolved = new Map(
      Object.entries(next.overrides).map(
        ([key, binding]) => [key, Object.freeze([binding])] as const,
      ),
    );
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      const raw = host?.localStorage.getItem(SHORTCUT_BINDINGS_KEY);
      publish({
        overrides: raw ? parseOverrides(JSON.parse(raw)) : NO_OVERRIDES,
        error: null,
      });
    } catch {
      publish({ overrides: NO_OVERRIDES, error: RESTORE_ERROR });
    }
  };
  // The change applies in memory even when the save fails; the page offers a retry.
  const commit = (overrides: ShortcutOverrides) => {
    let error: string | null = null;
    try {
      if (!host) throw new Error("No browser storage");
      if (Object.keys(overrides).length)
        host.localStorage.setItem(
          SHORTCUT_BINDINGS_KEY,
          JSON.stringify(overrides),
        );
      else host.localStorage.removeItem(SHORTCUT_BINDINGS_KEY);
    } catch {
      error = SAVE_ERROR;
    }
    publish({ overrides, error });
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SHORTCUT_BINDINGS_KEY && event.key !== null) return;
    // Re-read the current value: an older queued event must not undo a newer save.
    try {
      if (event.storageArea !== host?.localStorage) return;
    } catch {
      /* restore reports the failure */
    }
    restore();
  };
  restore();
  host?.addEventListener("storage", onStorage);
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Dispatcher lookup at match time; undefined means the registered default. */
    resolve: (key: string) => resolved.get(key),
    set(key: string, binding: KeyBinding | null) {
      if (disposed) return;
      if (binding !== null && !isKeyBinding(binding))
        throw new Error("Invalid shortcut binding");
      const rest = Object.entries(state.overrides).filter(
        ([entry]) => entry !== key,
      );
      commit(
        freezeOverrides(binding === null ? rest : [...rest, [key, binding]]),
      );
    },
    reset() {
      if (!disposed) commit(NO_OVERRIDES);
    },
    /** Re-attempt persisting what is already active after a failed save. */
    retry() {
      if (!disposed) commit(state.overrides);
    },
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type ShortcutBindings = ReturnType<typeof createShortcutBindings>;
