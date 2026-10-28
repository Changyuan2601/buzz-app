// FOUNDATION: One dispatcher; plugin readiness/lifetime remain owned by Cordis.
import { TERMINAL_KEY_EVENT } from "./terminal-key-event";
import { Service, type Context } from "@deepseek-ai/cordis";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import {
  inEditable,
  isBindingList,
  matches,
  normalizeShortcut,
  type KeyBinding,
  type NormalizedShortcut,
  type Shortcut,
} from "./bindings";
export type { KeyBinding, NormalizedShortcut, Shortcut } from "./bindings";
export type RegisteredShortcut = Contribution<NormalizedShortcut>;
export type Shortcuts = {
  register(shortcut: Shortcut): void;
  snapshot(): readonly RegisteredShortcut[];
  subscribe(listener: () => void): () => void;
};
/** Device-local user rebinds, keyed by host id or namespaced contribution key. */
export type BindingOverrides = {
  /** A stored override is a nonempty alias list; anything else means the default. */
  resolve(key: string): readonly KeyBinding[] | undefined;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    shortcuts: Shortcuts;
  }
}

export class ShortcutsService extends Service implements Shortcuts {
  private readonly contributions;
  private readonly hostBindings = new Map<string, NormalizedShortcut>();
  private readonly hostListeners = new Set<() => void>();
  private hostReady: readonly NormalizedShortcut[] = Object.freeze([]);
  constructor(
    ctx: Context,
    host: Window | undefined = typeof window === "undefined"
      ? undefined
      : window,
    overrides?: BindingOverrides,
  ) {
    super(ctx, "shortcuts");
    this.contributions = createContributions<NormalizedShortcut>(ctx);
    const apple = /Mac|iPhone|iPad/.test(host?.navigator.platform ?? "");
    // The effective chord is resolved at match time, so a rebind never requires
    // re-registration and survives plugin disable/enable. Anything that is not
    // a binding list (a malformed store entry, an inherited property under a
    // key such as "constructor") means the default, so dispatch cannot throw.
    const bindingsFor = (shortcut: NormalizedShortcut, key: string) => {
      const override = overrides?.resolve(key);
      return isBindingList(override) ? override : shortcut.binding;
    };
    const dispatch = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph")
      )
        return;
      const editable = inEditable(event);
      const modalSelector = 'dialog[open], [aria-modal="true"]';
      // Most keys match no shortcut; only a matching one pays for the document query.
      let modal: boolean | undefined;
      const inModal = () =>
        (modal ??=
          !!host?.document.querySelector(modalSelector) ||
          event
            .composedPath()
            .some((target) => (target as Element).matches?.(modalSelector)));
      const eligible = (shortcut: Shortcut) => {
        try {
          return (
            (!editable || shortcut.allowInEditable) &&
            (shortcut.allowInModal || !inModal()) &&
            (!shortcut.when || shortcut.when())
          );
        } catch (error) {
          console.error(`Shortcut predicate failed: ${shortcut.id}`, error);
          return false;
        }
      };
      // Host chords are reserved even while unavailable (e.g. Settings behind a modal).
      const reserved = [...this.hostBindings.values()].find((shortcut) =>
        matches(bindingsFor(shortcut, shortcut.id), event, apple),
      );
      const shortcut = reserved
        ? eligible(reserved)
          ? reserved
          : undefined
        : [...this.contributions.snapshot()]
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .find(
              (shortcut) =>
                matches(bindingsFor(shortcut, shortcut.key), event, apple) &&
                eligible(shortcut),
            );
      if (!shortcut) return;
      event.preventDefault();
      if (event.repeat && !shortcut.repeat) return;
      try {
        void Promise.resolve(shortcut.run()).catch((error) =>
          console.error(`Shortcut failed: ${shortcut.id}`, error),
        );
      } catch (error) {
        console.error(`Shortcut failed: ${shortcut.id}`, error);
      }
    };
    // Only xterm needs an early handoff: ordinary editors still handle keys first.
    const terminalKey = (event: Event) =>
      dispatch((event as CustomEvent<KeyboardEvent>).detail);
    ctx.effect(() => {
      host?.addEventListener(TERMINAL_KEY_EVENT, terminalKey);
      host?.addEventListener("keydown", dispatch);
      return () => {
        host?.removeEventListener("keydown", dispatch);
        host?.removeEventListener(TERMINAL_KEY_EVENT, terminalKey);
        this.hostBindings.clear();
        this.publishHost();
      };
    });
  }
  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  register(shortcut: Shortcut) {
    this.contributions.register(this.ctx, normalizeShortcut(shortcut));
  }
  /** Host composition only; not part of the injected plugin contract. */
  registerHost(shortcut: Shortcut) {
    const entry = normalizeShortcut(shortcut);
    if (this.hostBindings.has(entry.id))
      throw new Error(`Host shortcut already registered: ${entry.id}`);
    this.hostBindings.set(entry.id, entry);
    this.publishHost();
    return () => {
      if (this.hostBindings.get(entry.id) !== entry) return;
      this.hostBindings.delete(entry.id);
      this.publishHost();
    };
  }
  /** Host-only read path for Settings; plugins keep seeing only contributions. */
  hostSnapshot = () => this.hostReady;
  hostSubscribe = (listener: () => void) => {
    this.hostListeners.add(listener);
    return () => {
      this.hostListeners.delete(listener);
    };
  };
  private publishHost() {
    this.hostReady = Object.freeze([...this.hostBindings.values()]);
    for (const listener of this.hostListeners) listener();
  }
}
