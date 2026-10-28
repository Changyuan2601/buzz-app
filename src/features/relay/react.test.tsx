// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
  Profile,
} from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { useChannelWindow, useRowProfiles } from "./react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  let snapshot = { status: "ready", rows: [] } as unknown as ChannelWindow;
  const listeners = new Set<() => void>();
  const queries = {
    ensure: () => {},
    window: () => snapshot,
    subscribeWindow(_channelId: string, listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChannelQueries;
  return {
    queries,
    listeners,
    set(next: ChannelWindow) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
const nextWindow = (id: string) =>
  ({ status: "ready", rows: [{ id }] }) as unknown as ChannelWindow;

it("renders window changes once at the start of the next frame", () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const source = channelWindows();
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useChannelWindow(source.queries, "alpha");
  });
  const before = renders;
  act(() => {
    source.set(nextWindow("a"));
    source.set(nextWindow("b"));
  });
  expect(renders).toBe(before);
  expect(frames).toHaveLength(1);
  act(() => frames.shift()?.(0));
  expect(result.current.rows.map(({ id }) => id)).toEqual(["b"]);
  expect(renders).toBe(before + 1);
});

it("renders window changes directly while the document is hidden", () => {
  const frame = vi.spyOn(window, "requestAnimationFrame");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const source = channelWindows();
  const { result } = renderHook(() =>
    useChannelWindow(source.queries, "alpha"),
  );
  act(() => source.set(nextWindow("a")));
  expect(result.current.rows.map(({ id }) => id)).toEqual(["a"]);
  expect(frame).not.toHaveBeenCalled();
});

it("cancels a pending frame when the window is released", () => {
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
  const source = channelWindows();
  const { unmount } = renderHook(() =>
    useChannelWindow(source.queries, "alpha"),
  );
  act(() => source.set(nextWindow("a")));
  unmount();
  expect(cancel).toHaveBeenCalledWith(7);
  expect(source.listeners.size).toBe(0);
});
