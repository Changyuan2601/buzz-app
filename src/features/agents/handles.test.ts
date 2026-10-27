import { expect, it, vi } from "vitest";
import { handle, keyedRead, local } from "./handles";

it("keeps what a key read before while its content is the same", () => {
  let sessions: Record<string, { key: string; busy: boolean }[]> = {
    a: [{ key: "one", busy: false }],
    b: [{ key: "two", busy: true }],
  };
  // Each read builds new arrays, as the runtimes' saved-conversation reads do.
  const handle = keyedRead(
    (key) => (sessions[key] ?? []).map((session) => ({ ...session })),
    () => () => {},
    [],
  );
  const a = handle.read("a");
  const b = handle.read("b");
  expect(handle.read("a")).toBe(a);
  sessions = { ...sessions, a: [{ key: "one", busy: true }] };
  const changed = handle.read("a");
  expect(changed).not.toBe(a);
  expect(changed).toEqual([{ key: "one", busy: true }]);
  expect(handle.read("b")).toBe(b);
});

it("gives screens a type's handles with calls answering by promise", async () => {
  const listeners = new Set<() => void>();
  const store = {
    snapshot: () => "ready",
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: () => "checked",
  };
  const sessions = keyedRead(() => ["one"], store.subscribe, []);
  const exposed = local({
    store,
    sessions,
    fail: () => {
      throw new Error("failed");
    },
    list: [{ load: async () => 3 }],
  });
  expect(exposed.store.snapshot()).toBe("ready");
  expect(exposed.store.subscribe).toBe(store.subscribe);
  await expect(exposed.store.check()).resolves.toBe("checked");
  expect(exposed.sessions.read("a")).toBe(sessions.read("a"));
  await expect(exposed.fail()).rejects.toThrow("failed");
  const [item] = exposed.list;
  await expect(item?.load()).resolves.toBe(3);
});

it("refuses an exposed object that is not a plain handle", () => {
  class Setup {
    check() {}
  }
  expect(() => local({ setup: new Setup() })).toThrow(
    "expose.setup is not a plain object",
  );
  const setup = new Setup();
  const check = vi.spyOn(setup, "check");
  const picked = local({ setup: handle(setup, ["check"]) });
  void picked.setup.check();
  expect(check).toHaveBeenCalledOnce();
});
