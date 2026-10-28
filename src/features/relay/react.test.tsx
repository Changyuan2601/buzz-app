// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type {
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
  Profile,
} from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import {
  useChannelLoadingOlder,
  useChannelWindow,
  useRowProfiles,
} from "./react";

afterEach(cleanup);

function profiles() {
  let snapshot: ReadonlyMap<string, Profile> = new Map();
  const listeners = new Set<() => void>();
  const queries: ProfileQueries = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: async () => {},
  };
  return {
    queries,
    listeners,
    set(id: string, name?: string) {
      const next = new Map(snapshot);
      if (name) next.set(id, { name } as Profile);
      else next.delete(id);
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
const row = (authorId: string) =>
  ({ authorId, mentions: [], participants: [] }) as unknown as ChannelMessage;

it("keeps the selected map while added rows have no loaded profile", () => {
  const source = profiles();
  source.set("a", "Alice");
  const { result, rerender } = renderHook(
    ({ rows }) => useRowProfiles(source.queries, rows),
    { initialProps: { rows: [row("a")] } },
  );
  const first = result.current;
  expect([...first]).toEqual([["a", { name: "Alice" }]]);
  // A page adds an author still loading: same values, same identity.
  rerender({ rows: [row("a"), row("b")] });
  expect(result.current).toBe(first);
  // Its arrival, and a narrower demand, are real changes.
  act(() => source.set("b", "Bob"));
  expect([...result.current.keys()]).toEqual(["a", "b"]);
  const both = result.current;
  rerender({ rows: [row("b")] });
  expect(result.current).not.toBe(both);
  expect([...result.current]).toEqual([["b", { name: "Bob" }]]);
});

it("replaces the seed for swapped authors, updates, removal and a new source", () => {
  const source = profiles();
  source.set("a", "Alice");
  source.set("b", "Bob");
  const { result, rerender, unmount } = renderHook(
    ({ queries, rows }) => useRowProfiles(queries, rows),
    { initialProps: { queries: source.queries, rows: [row("a")] } },
  );
  rerender({ queries: source.queries, rows: [row("b")] });
  expect([...result.current]).toEqual([["b", { name: "Bob" }]]);
  act(() => source.set("b", "Robert"));
  expect([...result.current]).toEqual([["b", { name: "Robert" }]]);
  act(() => source.set("b"));
  expect(result.current.size).toBe(0);
  // Reload it, so the new source missing it is a real change.
  act(() => source.set("b", "Robert"));
  const other = profiles();
  rerender({ queries: other.queries, rows: [row("b")] });
  expect(result.current.size).toBe(0);
  act(() => other.set("b", "Other Bob"));
  expect([...result.current]).toEqual([["b", { name: "Other Bob" }]]);
  // The replaced source no longer drives this view.
  expect(source.listeners.size).toBe(0);
  act(() => source.set("b", "Stale"));
  expect([...result.current]).toEqual([["b", { name: "Other Bob" }]]);
  unmount();
  expect(other.listeners.size).toBe(0);
});

function channelWindows() {
  const rows: readonly ChannelMessage[] = [];
  let window: ChannelWindow = {
    channelId: "channel",
    status: "ready",
    rows,
    hasMore: true,
    loadingOlder: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const queries = {
    ensure: () => {},
    window: () => window,
    subscribeWindow(_: string, listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChannelQueries;
  return {
    queries,
    set(patch: Partial<ChannelWindow>) {
      window = { ...window, ...patch };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

it("keeps a quiet window while only an older load starts, and follows every other change", () => {
  const c = channelWindows();
  const quiet = renderHook(() => ({
    window: useChannelWindow(c.queries, "channel", true),
    loading: useChannelLoadingOlder(c.queries, "channel"),
  }));
  const plain = renderHook(() => useChannelWindow(c.queries, "channel"));
  const held = quiet.result.current.window;
  c.set({ loadingOlder: true });
  expect(quiet.result.current.window).toBe(held);
  expect(quiet.result.current.loading).toBe(true);
  expect(plain.result.current.loadingOlder).toBe(true);
  // Any other change while loading delivers the current window.
  c.set({ freshness: "verified" });
  expect(quiet.result.current.window.loadingOlder).toBe(true);
  expect(quiet.result.current.window.freshness).toBe("verified");
  // So does the end of a load, even with nothing else changed.
  c.set({ loadingOlder: false });
  expect(quiet.result.current.window.loadingOlder).toBe(false);
  expect(quiet.result.current.loading).toBe(false);
  // A start that also clears an error is not quiet.
  c.set({ error: "failed" });
  c.set({ loadingOlder: true, error: undefined });
  expect(quiet.result.current.window.loadingOlder).toBe(true);
  expect(quiet.result.current.window.error).toBeUndefined();
});
