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
  previous?: NavigationEntry;
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
        ...(typeof raw.previous?.id === "string"
          ? {
              previous: Object.freeze({
                id: raw.previous.id,
                target: parseOpenTarget(raw.previous.target),
              }),
            }
          : {}),
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
  let returning: string | undefined;
  const visitsKey = () => `buzz-navigation-visits:${stamp.chain}`;
  function readKnown() {
    const known = new Map<number, NavigationEntry>();
    try {
      const saved: unknown = JSON.parse(
        host.sessionStorage.getItem(visitsKey()) ?? "[]",
      );
      if (Array.isArray(saved))
        for (const raw of saved) {
          const visit = decode(raw);
          if (visit?.chain === stamp.chain) known.set(visit.index, visit.entry);
        }
    } catch {
      /* Live traversal still works without saved visits. */
    }
    return known;
  }
  let known = readKnown();
  known.set(stamp.index, stamp.entry);
  // Keep the immediate opener across reload so dismissing a restored dialog
  // can return to it without leaving an identical-looking history stop.
  if (stamp.index > 0 && stamp.previous)
    known.set(stamp.index - 1, stamp.previous);
  const dismissedKey = () => `buzz-navigation-dismissed:${stamp.chain}`;
  function readDismissed() {
    try {
      const value: unknown = JSON.parse(
        host.sessionStorage.getItem(dismissedKey()) ?? "[]",
      );
      return new Set<number>(
        Array.isArray(value)
          ? value.filter((index) => Number.isSafeInteger(index) && index >= 0)
          : [],
      );
    } catch {
      return new Set<number>();
    }
  }
  let dismissed = readDismissed();
  function saveDismissed() {
    try {
      host.sessionStorage.setItem(
        dismissedKey(),
        JSON.stringify([...dismissed]),
      );
    } catch {
      /* Dismissal still holds for this document. */
    }
  }
  const endKey = () => `buzz-navigation-end:${stamp.chain}`;
  let end = stamp.index;
  try {
    end = Math.max(end, Number(host.sessionStorage.getItem(endKey())) || 0);
  } catch {
    /* Restoration of forward affordance is best effort. */
  }
  const adjacent = (from: number, direction: -1 | 1) => {
    let next = from + direction;
    while (dismissed.has(next)) next += direction;
    return next >= 0 && next <= end ? next : -1;
  };
  function snapshotOf(): HistorySnapshot {
    const previous = known.get(adjacent(stamp.index, -1));
    return Object.freeze({
      current: stamp.entry,
      invalidAddress: stamp.invalidAddress === true,
      canGoBack: adjacent(stamp.index, -1) !== -1,
      canGoForward: adjacent(stamp.index, 1) !== -1,
      ...(previous ? { previous } : {}),
    });
  }
  let snapshot = snapshotOf();
  function publish() {
    snapshot = snapshotOf();
    try {
      host.sessionStorage.setItem(
        visitsKey(),
        JSON.stringify(
          [...known].map(([index, entry]) => ({
            chain: stamp.chain,
            index,
            entry,
          })),
        ),
      );
    } catch {
      /* Dismissal still works for this document. */
    }
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
      ...(replace
        ? stamp.previous && { previous: stamp.previous }
        : { previous: stamp.entry }),
    };
    const url = `${host.location.pathname}${host.location.search}${PREFIX}${encodeURIComponent(targetKey(entry.target))}`;
    host.history[replace ? "replaceState" : "pushState"](
      { ...host.history.state, [KEY]: next },
      "",
      url,
    );
    stamp = next;
    known.set(stamp.index, entry);
    dismissed.delete(stamp.index);
    if (!replace) {
      end = stamp.index;
      for (const index of known.keys()) if (index > end) known.delete(index);
      for (const index of dismissed) if (index > end) dismissed.delete(index);
    }
    saveDismissed();
    try {
      host.sessionStorage.setItem(endKey(), String(end));
    } catch {
      /* In-document traversal still works. */
    }
    publish();
  }
  let skipping: number | undefined;
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
      // A manual hash navigation truncates/reuses the forward branch too.
      for (const index of known.keys()) if (index >= end) known.delete(index);
      for (const index of dismissed) if (index >= end) dismissed.delete(index);
      saveDismissed();
    } else if (
      addressed &&
      targetKey(addressed) !== targetKey(next.entry.target)
    ) {
      next = {
        ...next,
        entry: navigationEntry(addressed),
        invalidAddress: false,
      };
      dismissed.delete(next.index);
      saveDismissed();
    }
    if (next.index === skipping) skipping = undefined;
    if (next.chain === stamp.chain && dismissed.has(next.index)) {
      const direction = next.index < stamp.index ? -1 : 1;
      const eligible = adjacent(next.index, direction);
      const destination = eligible === -1 ? stamp.index : eligible;
      // Browsers can emit both popstate and hashchange before go completes.
      if (skipping !== destination) {
        skipping = destination;
        host.history.go(destination - next.index);
      }
      return;
    }
    if (
      next.entry.id === stamp.entry.id &&
      next.chain === stamp.chain &&
      next.index === stamp.index &&
      (addressed === null) === (stamp.invalidAddress === true)
    ) {
      // popstate + hashchange describe one traversal, not two attempts.
      return;
    }
    next = { ...next, invalidAddress: addressed === null };
    const newChain = next.chain !== stamp.chain;
    if (newChain) {
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
    returning = undefined;
    if (newChain) {
      known = readKnown();
      dismissed = readDismissed();
    }
    known.set(stamp.index, stamp.entry);
    if (stamp.index > 0 && stamp.previous && !known.has(stamp.index - 1))
      known.set(stamp.index - 1, stamp.previous);
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
    dismiss(visits, input) {
      if (disposed || (typeof visits !== "function" && !visits.length)) return;
      const fallback = parseOpenTarget(input);
      const closing = [...known].filter(([, entry]) =>
        typeof visits === "function"
          ? visits(entry.target)
          : visits.includes(entry.id),
      );
      for (const [index] of closing) dismissed.add(index);
      saveDismissed();
      if (dismissed.has(stamp.index)) {
        const previous = adjacent(stamp.index, -1);
        const entry = known.get(previous);
        if (entry && targetKey(entry.target) === targetKey(fallback)) {
          // Retirement can keep changing while this native return is pending.
          // Its pop handler will skip any newly retired destination in turn.
          if (returning) return;
          returning = entry.id;
          host.history.go(previous - stamp.index);
          return;
        }
        // A cold/deep-linked thread has no channel visit beneath it. Replace
        // it with that channel rather than navigating to an unrelated page.
        write(fallback, true);
        return;
      }
      publish();
    },
    back() {
      const next = adjacent(stamp.index, -1);
      if (!disposed && next !== -1) host.history.go(next - stamp.index);
    },
    forward() {
      const next = adjacent(stamp.index, 1);
      if (!disposed && next !== -1) host.history.go(next - stamp.index);
    },
    returnTo(entryId) {
      if (returning) return returning === entryId;
      const visit = [...known].find(([, entry]) => entry.id === entryId);
      if (disposed || !visit || dismissed.has(visit[0])) return false;
      const delta = visit[0] - stamp.index;
      if (delta === 0) return stamp.entry.id === entryId;
      returning = entryId;
      host.history.go(delta);
      return true;
    },
    dispose() {
      disposed = true;
      controller = undefined;
      host.removeEventListener("popstate", pop);
      host.removeEventListener("hashchange", pop);
    },
  };
}
