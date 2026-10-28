import {
  navigationEntry,
  homeTarget,
  type NavigationEntry,
  type NavigationHistory,
  type HistorySnapshot,
} from "./history";
import { parseOpenTarget, targetKey, type OpenTarget } from "./targets";

const KEY = "buzzNavigationV1";
const PREFIX = "#buzz=";
type Stamp = {
  chain: string;
  index: number;
  entry: NavigationEntry;
  invalidAddress?: boolean;
};
/** One browser session-history driver: toolbar/shortcuts call go; popstate never pushes. */
export function createBrowserHistory(host: Window): NavigationHistory {
  let disposed = false,
    attached = false;
  let controller: (() => void) | undefined;
  const decode = (value: unknown): Stamp | undefined => {
    try {
      if (!value || typeof value !== "object") return;
      const raw = value as Stamp;
      if (
        typeof raw.chain !== "string" ||
        typeof raw.entry?.id !== "string" ||
        !Number.isSafeInteger(raw.index) ||
        raw.index < 0
      )
        return;
      return {
        ...(raw.invalidAddress === true ? { invalidAddress: true } : {}),
        chain: raw.chain,
        index: raw.index,
        entry: Object.freeze({
          id: raw.entry.id,
          target: parseOpenTarget(raw.entry.target),
        }),
      };
    } catch {
      return;
    }
  };
  function urlTarget(): OpenTarget | null | undefined {
    if (!host.location.hash.startsWith(PREFIX)) return;
    try {
      return parseOpenTarget(
        JSON.parse(decodeURIComponent(host.location.hash.slice(PREFIX.length))),
      );
    } catch {
      return null;
    }
  }
  let current = decode(host.history.state?.[KEY]);
  const addressed = urlTarget();
  if (!current) {
    current = {
      chain: crypto.randomUUID(),
      index: 0,
      entry: navigationEntry(addressed ?? homeTarget),
    };
  } else if (
    addressed &&
    targetKey(addressed) !== targetKey(current.entry.target)
  ) {
    current = { ...current, entry: navigationEntry(addressed) };
  }
  current = { ...current, invalidAddress: addressed === null };
  host.history.replaceState({ ...host.history.state, [KEY]: current }, "");
  let stamp: Stamp = current;
  const endKey = () => `buzz-navigation-end:${stamp.chain}`;
  let end = stamp.index;
  try {
    end = Math.max(end, Number(host.sessionStorage.getItem(endKey())) || 0);
  } catch {
    /* Restoration of forward affordance is best effort. */
  }
  function snapshotOf(): HistorySnapshot {
    return Object.freeze({
      current: stamp.entry,
      invalidAddress: stamp.invalidAddress === true,
      canGoBack: stamp.index > 0,
      canGoForward: stamp.index < end,
    });
  }
  let snapshot = snapshotOf();
  function publish() {
    snapshot = snapshotOf();
    controller?.();
  }
  function write(target: OpenTarget, replace: boolean, resolve = false) {
    if (disposed) return;
    const entry = resolve
      ? Object.freeze({ id: stamp.entry.id, target: parseOpenTarget(target) })
      : navigationEntry(target);
    if (
      !replace &&
      !stamp.invalidAddress &&
      targetKey(entry.target) === targetKey(stamp.entry.target)
    )
      return;
    const next: Stamp = {
      chain: stamp.chain,
      index: stamp.index + (replace ? 0 : 1),
      entry,
    };
    const url = `${host.location.pathname}${host.location.search}${PREFIX}${encodeURIComponent(targetKey(entry.target))}`;
    host.history[replace ? "replaceState" : "pushState"](
      { ...host.history.state, [KEY]: next },
      "",
      url,
    );
    stamp = next;
    if (!replace) end = stamp.index;
    try {
      host.sessionStorage.setItem(endKey(), String(end));
    } catch {
      /* In-document traversal still works. */
    }
    publish();
  }
  const pop = () => {
    if (disposed) return;
    let next = decode(host.history.state?.[KEY]);
    const addressed = urlTarget();
    if (!next) {
      // A hash edit already appended a native entry. Adopt it in this chain,
      // replacing only its stamp; never push again or fabricate a Home visit.
      next = {
        chain: stamp.chain,
        index: stamp.index + 1,
        entry: navigationEntry(addressed ?? stamp.entry.target),
        invalidAddress: addressed === null,
      };
      end = next.index;
    } else if (
      addressed &&
      targetKey(addressed) !== targetKey(next.entry.target)
    ) {
      next = {
        ...next,
        entry: navigationEntry(addressed),
        invalidAddress: false,
      };
    } else if (
      next.entry.id === stamp.entry.id &&
      next.chain === stamp.chain &&
      next.index === stamp.index &&
      (addressed === null) === (stamp.invalidAddress === true)
    ) {
      // popstate + hashchange describe one traversal, not two attempts.
      return;
    }
    next = { ...next, invalidAddress: addressed === null };
    if (next.chain !== stamp.chain) {
      end = next.index;
      try {
        end = Math.max(
          end,
          Number(
            host.sessionStorage.getItem(`buzz-navigation-end:${next.chain}`),
          ) || 0,
        );
      } catch {
        /* Forward affordance is best effort across documents. */
      }
    }
    host.history.replaceState({ ...host.history.state, [KEY]: next }, "");
    stamp = next;
    try {
      host.sessionStorage.setItem(endKey(), String(end));
    } catch {
      /* In-document traversal still works. */
    }
    publish();
  };
  host.addEventListener("popstate", pop);
  host.addEventListener("hashchange", pop);
  return {
    snapshot: () => snapshot,
    attach(listener) {
      if (attached || disposed)
        throw new Error("Navigation history already has an owner");
      attached = true;
      controller = listener;
      return () => {
        controller = undefined;
      };
    },
    push: (target) => write(target, false),
    resolve: (target) => write(target, true, true),
    replace: (target) => write(target, true),
    back() {
      if (!disposed && snapshot.canGoBack) host.history.back();
    },
    forward() {
      if (!disposed && snapshot.canGoForward) host.history.forward();
    },
    dispose() {
      disposed = true;
      controller = undefined;
      host.removeEventListener("popstate", pop);
      host.removeEventListener("hashchange", pop);
    },
  };
}
