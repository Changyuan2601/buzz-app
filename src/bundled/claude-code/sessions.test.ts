import { afterEach, expect, it, vi } from "vitest";
import { fakeSpawn, flush } from "./claude-testing";
import {
  AgentSessions,
  IDLE_MS,
  localSessions,
  MAX_LIVE,
  type SavedSession,
  type SessionStore,
} from "./sessions";

afterEach(() => {
  vi.useRealTimers();
});

const memoryStore = (): SessionStore & { all: Map<string, SavedSession> } => {
  const all = new Map<string, SavedSession>();
  return {
    all,
    get: (key) => all.get(key),
    set: (key, session) => void all.set(key, session),
    delete: (key) => void all.delete(key),
  };
};

function sessions(
  options: Partial<{
    known: Set<string>;
    store: ReturnType<typeof memoryStore>;
    /** Every process keeps its turns open until finished. */
    hold: boolean;
    /** Holds each launch after it reads the settings, as a memory read does. */
    launched: Promise<void>;
  }> = {},
) {
  const fake = fakeSpawn(options.known);
  const store = options.store ?? memoryStore();
  let model = "opus";
  let ids = 0;
  const pool = new AgentSessions({
    spawn: (id, spawnOptions) => {
      // The fake records each process as the call begins.
      const process = fake.spawn(id, spawnOptions);
      const started = fake.processes.at(-1);
      if (options.hold && started) started.hold = true;
      return process;
    },
    store,
    launch: async () => {
      const current = model;
      await options.launched;
      return { cwd: "/work", systemPrompt: "prompt", model: current };
    },
    fingerprint: () => model,
    newId: () => `new-${++ids}`,
  });
  const claudes = () =>
    fake.processes.filter((process) => process.id === "claude");
  return {
    pool,
    store,
    claudes,
    live: () => claudes().filter((process) => !process.killed),
    setModel: (next: string) => {
      model = next;
    },
  };
}

it("starts a new conversation on the warm spare and warms another", async () => {
  const { pool, store, claudes } = sessions();
  pool.warm();
  await flush();
  expect(claudes()).toHaveLength(1);
  await expect(pool.deliver("c/root", "hello", 10)).resolves.toEqual({
    ok: true,
  });
  await flush();
  expect(claudes()).toHaveLength(2);
  expect(claudes()[0]?.prompts).toEqual(["hello"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 10 });
  expect(pool.snapshot()).toEqual([{ key: "c/root", busy: false }]);
});

it("continues a conversation in its own process, apart from others", async () => {
  const { pool, claudes } = sessions();
  await pool.deliver("c/one", "first", 1);
  await pool.deliver("c/two", "other", 2);
  await pool.deliver("c/one", "second", 3);
  const prompts = claudes().map((process) => process.prompts);
  expect(prompts).toContainEqual(["first", "second"]);
  expect(prompts).toContainEqual(["other"]);
});

it("steers a conversation that is still working instead of queueing", async () => {
  const { pool, claudes } = sessions();
  pool.warm();
  await flush();
  const process = claudes()[0];
  if (!process) throw new Error("no spare");
  process.hold = true;
  const first = pool.deliver("c/root", "first", 1);
  await flush();
  const second = pool.deliver("c/root", "plain", 2, { steer: "steer" });
  await flush();
  expect(process.prompts).toEqual(["first", "steer"]);
  expect(pool.snapshot()).toEqual([{ key: "c/root", busy: true }]);
  process.finish();
  await expect(first).resolves.toEqual({ ok: true });
  await expect(second).resolves.toEqual({ ok: true });
});

it("opens one process for messages that arrive together in a new conversation", async () => {
  const { pool, claudes } = sessions();
  await Promise.all([
    pool.deliver("c/root", "one", 1),
    pool.deliver("c/root", "two", 2),
  ]);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used).toHaveLength(1);
  expect(used[0]?.prompts).toEqual(["one", "two"]);
});

it("resumes a saved conversation after its process stops", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const { pool, claudes } = sessions({ store });
  await pool.deliver("c/root", "first", 1);
  const first = claudes()[0];
  vi.advanceTimersByTime(IDLE_MS + 1);
  expect(first?.killed).toBe(true);
  expect(pool.snapshot()).toEqual([]);
  await pool.deliver("c/root", "later", 5);
  const resumed = claudes().at(-1);
  expect(resumed?.options.args).toContain("--resume");
  expect(resumed?.options.args).toContain("new-1");
  expect(resumed?.prompts).toEqual(["later"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 5 });
});

it("starts over when a saved session no longer loads", async () => {
  const store = memoryStore();
  store.set("c/root", { id: "lost", seen: 4, at: 1 });
  const { pool, claudes } = sessions({ store });
  await expect(
    pool.deliver("c/root", "hello", 9, {
      fresh: async () => "hello, with the thread so far",
    }),
  ).resolves.toEqual({ ok: true });
  const [failed, fresh] = claudes();
  expect(failed?.options.args).toContain("lost");
  expect(fresh?.options.args).toContain("--session-id");
  expect(fresh?.prompts).toEqual(["hello, with the thread so far"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 9 });
});

it("runs a turn with the model and effort it was delivered with, starting over included", async () => {
  const store = memoryStore();
  store.set("c/root", { id: "lost", seen: 4, at: 1 });
  const { pool, claudes } = sessions({ store });
  await pool.deliver("c/root", "hello", 9, {
    fresh: async () => "hello again",
    pick: { model: "haiku", effort: "low" },
  });
  await pool.deliver("c/root", "next", 10);
  const fresh = claudes().find((process) => process.prompts.length);
  expect(fresh?.prompts).toEqual(["hello again", "next"]);
  expect(fresh?.models).toEqual(["haiku", "opus"]);
  expect(fresh?.efforts).toEqual(["low", "high"]);
});

it("stops the longest-idle conversation to stay within its process limit", async () => {
  const { pool, live } = sessions();
  for (let index = 0; index < MAX_LIVE + 2; index++)
    await pool.deliver(`c/${index}`, "hi", index);
  await flush();
  expect(live().length).toBeLessThanOrEqual(MAX_LIVE);
  const keys = pool.snapshot().map((session) => session.key);
  expect(keys).not.toContain("c/0");
  expect(keys).toContain(`c/${MAX_LIVE + 1}`);
});

it("says it is busy rather than start a process past its limit", async () => {
  const { pool, live } = sessions({ hold: true });
  pool.warm();
  for (let index = 0; index < MAX_LIVE; index++)
    void pool.deliver(`c/${index}`, "hi", index);
  await flush();
  expect(live()).toHaveLength(MAX_LIVE);
  await expect(pool.deliver("c/extra", "hi", 9)).resolves.toEqual({
    ok: false,
    error: `Claude Code is already working in ${MAX_LIVE} conversations; try again when one finishes`,
  });
  expect(live()).toHaveLength(MAX_LIVE);
  expect(pool.snapshot().map((session) => session.key)).not.toContain(
    "c/extra",
  );
});

it("counts conversations still starting toward its limit", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, live } = sessions({ hold: true, launched });
  const results = Array.from({ length: MAX_LIVE + 1 }, (_, index) =>
    pool.deliver(`c/${index}`, "hi", index),
  );
  await expect(results[MAX_LIVE]).resolves.toMatchObject({ ok: false });
  release();
  await flush();
  expect(live()).toHaveLength(MAX_LIVE);
});

it("starts again with settings saved while a conversation's process started", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes, setModel } = sessions({ launched });
  const done = pool.deliver("c/root", "hi", 1);
  await flush();
  setModel("sonnet");
  pool.reconfigure();
  release();
  await expect(done).resolves.toEqual({ ok: true });
  const [old] = claudes();
  expect(old?.options.args).toContain("opus");
  expect(old?.killed).toBe(true);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used).toHaveLength(1);
  expect(used[0]?.options.args).toContain("sonnet");
});

it("restarts idle processes and the spare when settings change", async () => {
  const { pool, claudes, setModel } = sessions();
  await pool.deliver("c/root", "hi", 1);
  await flush();
  const [conversation, spare] = claudes();
  setModel("sonnet");
  pool.reconfigure();
  await flush();
  expect(conversation?.killed).toBe(true);
  expect(spare?.killed).toBe(true);
  expect(claudes().at(-1)?.options.args).toContain("sonnet");
  await pool.deliver("c/root", "again", 2);
  const resumed = claudes().at(-1);
  expect(resumed?.options.args).toEqual(
    expect.arrayContaining(["--resume", "new-1", "--model", "sonnet"]),
  );
});

it("stops every process when disposed", async () => {
  const { pool, claudes } = sessions();
  pool.warm();
  await pool.deliver("c/root", "hi", 1);
  await flush();
  pool.dispose();
  await flush();
  expect(claudes().every((process) => process.killed)).toBe(true);
  await expect(pool.deliver("c/root", "late", 2)).resolves.toMatchObject({
    ok: false,
  });
});

it("keeps saved sessions per agent in storage", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const one = localSessions(storage, "one");
  const two = localSessions(storage, "two");
  one.set("c/root", { id: "s1", seen: 3, at: 1 });
  two.set("c/root", { id: "s2", seen: 4, at: 2 });
  expect(localSessions(storage, "one").get("c/root")?.id).toBe("s1");
  expect(two.get("c/root")?.id).toBe("s2");
  one.delete("c/root");
  expect(one.get("c/root")).toBeUndefined();
  expect(two.get("c/root")?.id).toBe("s2");
  data.set("buzz.claude-code.sessions.v1", "not json");
  expect(one.get("c/root")).toBeUndefined();
});
