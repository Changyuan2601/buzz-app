// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type {
  ChannelList,
  ChannelMessage,
  ChannelQueries,
  ChannelSummary,
  Profile,
} from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { useChannelListWithoutActivity, useRowProfiles } from "./react";

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

it("keeps the channel list through activity-only changes", () => {
  const channel = (patch: Partial<ChannelSummary> = {}) =>
    Object.freeze({ id: "a", name: "Alpha", ...patch }) as ChannelSummary;
  let list: ChannelList = Object.freeze({
    status: "ready",
    channels: [channel()],
  });
  const listeners = new Set<() => void>();
  const set = (next: ChannelList) => {
    list = next;
    for (const listener of listeners) listener();
  };
  const queries = {
    list: () => list,
    ensureList: () => {},
    subscribeList(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChannelQueries;
  const { result } = renderHook(() => useChannelListWithoutActivity(queries));
  const first = result.current;
  expect(first).toBe(list);
  act(() =>
    set({
      ...list,
      channels: [channel({ lastActivityAt: 10, activityKnown: true })],
    }),
  );
  expect(result.current).toBe(first);
  act(() =>
    set({
      ...list,
      channels: [channel({ lastActivityAt: 11, activityKnown: true })],
    }),
  );
  expect(result.current).toBe(first);
  // Any other channel or list change publishes the current snapshot, activity included.
  const renamed = {
    ...list,
    channels: [
      channel({ name: "Renamed", lastActivityAt: 11, activityKnown: true }),
    ],
  };
  act(() => set(renamed));
  expect(result.current).toBe(renamed);
  const loading = { ...renamed, status: "loading" as const };
  act(() => set(loading));
  expect(result.current).toBe(loading);
  const added = {
    ...loading,
    channels: [...loading.channels, channel({ id: "b" })],
  };
  act(() => set(added));
  expect(result.current).toBe(added);
});
