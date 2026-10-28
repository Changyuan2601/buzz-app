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
import { useChannelWindow, useLoadingOlder, useRowProfiles } from "./react";

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

it("keeps the window snapshot while only loadingOlder changes; the flag stays live", () => {
  let snapshot: ChannelWindow = Object.freeze({
    channelId: "c",
    status: "ready",
    rows: [row("a")],
    hasMore: true,
    loadingOlder: false,
    error: undefined,
  });
  const listeners = new Set<() => void>();
  const queries = {
    ensure: () => {},
    window: () => snapshot,
    subscribeWindow(_: string, listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChannelQueries;
  const set = (patch: Partial<ChannelWindow>) =>
    act(() => {
      snapshot = Object.freeze({ ...snapshot, ...patch });
      for (const listener of listeners) listener();
    });
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useChannelWindow(queries, "c");
  });
  const flag = renderHook(() =>
    useLoadingOlder(queries, "c", useChannelWindow(queries, "c")),
  );
  const first = result.current;
  set({ loadingOlder: true });
  expect(flag.result.current).toBe(true);
  expect(result.current).toBe(first);
  expect(renders).toBe(1);
  set({ loadingOlder: false });
  expect(flag.result.current).toBe(false);
  expect(result.current).toBe(first);
  set({ refreshing: true });
  expect(result.current).toBe(snapshot);
  // Any other change publishes the current snapshot, flags included.
  set({ loadingOlder: true, error: "offline" });
  expect(result.current).toBe(snapshot);
  expect(result.current.loadingOlder).toBe(true);
  set({ rows: [row("b")], loadingOlder: false });
  expect(result.current).toBe(snapshot);
});

it("reads loadingOlder from a window that is not a useChannelWindow snapshot", () => {
  const stored: ChannelWindow = Object.freeze({
    channelId: "c",
    status: "ready",
    rows: [],
    hasMore: true,
    loadingOlder: false,
    error: undefined,
  });
  const queries = {
    window: () => stored,
    subscribeWindow: () => () => {},
  } as unknown as ChannelQueries;
  const { result, rerender } = renderHook(
    ({ window }) => useLoadingOlder(queries, "c", window),
    { initialProps: { window: { ...stored, loadingOlder: true } } },
  );
  expect(result.current).toBe(true);
  rerender({ window: { ...stored, loadingOlder: false } });
  expect(result.current).toBe(false);
});
