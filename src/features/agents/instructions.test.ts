import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "../relay/live";
import type { Outbox, OutgoingEvent, Settlement } from "../relay/outbox";
import type { ReadFilter, RelayEvent } from "../relay/events";
import {
  CLEANUP_KEY,
  ConflictError,
  InstructionStore,
  InstructionSync,
  RESEND_WINDOW_SECONDS,
  type Inventory,
  recoveryKey,
  hash,
  resolveInstructions,
  saveState,
  subjectKey,
  HAD_VERSION_KEY,
  INSTRUCTIONS_STORE_KEY,
} from "./instructions";
import { INSTRUCTIONS_KIND } from "./instructions-envelope";

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const AGENT = "c".repeat(64);
const AGENT2 = "d".repeat(64);
const COMMUNITY = "wss://relay.test";
const T0 = 1_800_000_000;

let serial = 0;
const id = () => (++serial).toString(16).padStart(64, "0");

function version(
  text: string,
  created_at: number,
  agent = AGENT,
  pubkey = OWNER,
): RelayEvent {
  return {
    id: id(),
    pubkey,
    kind: INSTRUCTIONS_KIND,
    created_at,
    content: `c:${text}`,
    tags: [["p", agent]],
    sig: "s",
  } as RelayEvent;
}
function deletion(target: string, created_at = T0, pubkey = OWNER) {
  return {
    id: id(),
    pubkey,
    kind: 5,
    created_at,
    content: "",
    tags: [
      ["e", target],
      ["k", String(INSTRUCTIONS_KIND)],
    ],
    sig: "s",
  } as RelayEvent;
}

function memory(): Storage & { fail?: string | undefined } {
  const data = new Map<string, string>();
  const storage = {
    fail: undefined as string | undefined,
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      if (storage.fail === key) throw new Error("quota");
      data.set(key, value);
    },
  };
  return storage as unknown as Storage & { fail?: string | undefined };
}

/** The relay: ordered storage, newest-first pages with an until/before_id cursor. */
function fakeRelay() {
  const events: RelayEvent[] = [];
  const reads: ReadFilter[][] = [];
  let failing = false;
  let hold: Promise<void> | undefined;
  const matches = (f: ReadFilter, e: RelayEvent) =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f.ids || f.ids.includes(e.id)) &&
    (!f["#p"] ||
      e.tags.some(([n, v]) => n === "p" && f["#p"]?.includes(v ?? ""))) &&
    (!f["#k"] ||
      e.tags.some(([n, v]) => n === "k" && f["#k"]?.includes(v ?? ""))) &&
    (f.until === undefined ||
      e.created_at < f.until ||
      (e.created_at === f.until &&
        (f as { before_id?: string }).before_id !== undefined &&
        e.id > ((f as { before_id?: string }).before_id ?? "")));
  const deleted = () =>
    new Set(
      events
        .filter((e) => e.kind === 5)
        .flatMap((e) => e.tags.filter(([n]) => n === "e").map(([, v]) => v)),
    );
  return {
    events,
    reads,
    fail(value: boolean) {
      failing = value;
    },
    hold(promise: Promise<void> | undefined) {
      hold = promise;
    },
    async read(filters: readonly ReadFilter[]) {
      reads.push([...filters]);
      if (hold) await hold;
      if (failing) throw new Error("offline");
      const gone = deleted();
      const [f] = filters;
      if (!f) return [];
      return events
        .filter((e) => matches(f, e) && !gone.has(e.id))
        .sort((a, b) =>
          a.created_at !== b.created_at
            ? b.created_at - a.created_at
            : a.id < b.id
              ? -1
              : 1,
        )
        .slice(0, f.limit);
    },
  };
}

/** Outbox delivery the test drives: `answer` decides what each send returns. */
function fakeOutbox(relay: ReturnType<typeof fakeRelay>, clock: () => number) {
  let items: OutgoingEvent[] = [];
  const listeners = new Set<() => void>();
  const sends: RelayEvent[] = [];
  const settlements = new Map<string, Settlement>();
  const notify = () => {
    for (const l of listeners) l();
  };
  const update = (eventId: string, patch: Partial<OutgoingEvent>) => {
    items = items.map((i) => (i.event.id === eventId ? { ...i, ...patch } : i));
    notify();
  };
  const fake = {
    sends,
    settlements,
    /** "accept" stores and acknowledges; "lose" stores with no receipt;
     * "drop" never stores and loses the receipt; a string refuses. */
    answer: "accept" as "accept" | "lose" | "drop" | string,
    deliver(event: RelayEvent) {
      sends.push(event);
      const answer = fake.answer;
      if (answer === "hold") return;
      if (answer === "accept" || answer === "lose") {
        if (!relay.events.some((e) => e.id === event.id))
          relay.events.push(event);
      }
      if (answer === "accept") update(event.id, { delivery: "accepted" });
      else if (answer === "lose" || answer === "drop")
        update(event.id, { delivery: "unknown", dispatched: true });
      else {
        const prior = items.find((i) => i.event.id === event.id)?.delivery;
        update(event.id, {
          delivery:
            prior === "unknown" || answer.startsWith("error:")
              ? "unknown"
              : "failed",
          error: answer,
        });
      }
    },
    outbox: {
      snapshot: () => items,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      observeSend: () => () => {},
      supports: () => true,
      ready: async () => {},
      send(input, recovery) {
        const event = {
          id: id(),
          pubkey: OWNER,
          created_at: clock(),
          sig: "s",
          ...input,
        } as unknown as RelayEvent;
        items = [
          ...items,
          {
            event,
            signed: event,
            delivery: "sending",
            ...(recovery ? { recovery } : {}),
          },
        ];
        queueMicrotask(() => fake.deliver(event));
        return event.id;
      },
      async recover() {},
      async acknowledge() {},
      async settle(eventId: string) {
        const forced = settlements.get(eventId);
        if (forced) return forced;
        const item = items.find((i) => i.event.id === eventId);
        if (!item) return "absent";
        if (item.delivery === "accepted" || item.delivery === "seen")
          return "stored";
        if (!item.dispatched) return "unsent";
        return item.delivery === "failed" ? "rejected" : "uncertain";
      },
      async retire(eventId: string) {
        items = items.filter((i) => i.event.id !== eventId);
        notify();
      },
      retry(eventId: string) {
        const item = items.find((i) => i.event.id === eventId);
        if (item?.signed)
          queueMicrotask(() => fake.deliver(item.signed as RelayEvent));
      },
      async dismiss(eventId: string) {
        items = items.filter((i) => i.event.id !== eventId);
        notify();
      },
    } satisfies Outbox,
  };
  return fake;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const ready = (known: string[], deleted: string[] = []): Inventory => ({
  state: "ready",
  known: new Set(known),
  deleted: new Set(deleted),
});

function harness({
  storage = memory(),
  relay = fakeRelay(),
  owner = OWNER,
}: {
  storage?: Storage & { fail?: string | undefined };
  relay?: ReturnType<typeof fakeRelay>;
  owner?: string;
} = {}) {
  let now = T0;
  const clock = () => now;
  const box = fakeOutbox(relay, clock);
  const store = new InstructionStore(storage);
  let snapshot: LiveSnapshot = { status: "connecting", routes: [] };
  const liveListeners = new Set<() => void>();
  const batchListeners = new Set<
    (b: { events: readonly RelayEvent[] }) => void
  >();
  const controller = new AbortController();
  let admit: (id: string) => boolean = () => false;
  const decode = vi.fn(
    async (_subject: string, events: readonly RelayEvent[]) =>
      events.map((e) =>
        e.content.startsWith("c:")
          ? { id: e.id, text: e.content.slice(2) }
          : { id: e.id, invalid: "Can't read this version" },
      ),
  );
  const sync = new InstructionSync({
    owner,
    community: COMMUNITY,
    signal: controller.signal,
    store,
    codec: { prepare: async (_s, text) => `c:${text}`, decode },
    read: (filters) => relay.read(filters),
    outbox: box.outbox,
    live: {
      snapshot: () => snapshot,
      subscribe(listener) {
        liveListeners.add(listener);
        return () => void liveListeners.delete(listener);
      },
    },
    subscribeLive(listener) {
      batchListeners.add(listener);
      return () => void batchListeners.delete(listener);
    },
    admitDeletions(predicate) {
      admit = predicate;
      return () => {};
    },
    now: clock,
  });
  const route = (status: "pending" | "live" | "error") => {
    snapshot = {
      status: "connected",
      routes: [{ id: "instructions", status, replay: "unknown" }],
    };
    for (const l of liveListeners) l();
  };
  const push = (...events: RelayEvent[]) => {
    for (const l of batchListeners) l({ events });
  };
  const resolve = (agent = AGENT) =>
    resolveInstructions(
      store,
      owner,
      COMMUNITY,
      agent,
      { linked: false, legacy: "legacy" },
      sync.pendingDeletion(agent),
    );
  return {
    sync,
    store,
    storage,
    relay,
    box,
    decode,
    route,
    push,
    resolve,
    controller,
    admits: (id: string) => admit(id),
    advance(seconds: number) {
      now += seconds;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("instructions sync", () => {
  beforeEach(() => {
    serial = 0;
  });

  it("T3 scopes cached heads to the owner and keeps had-version through sign-out", async () => {
    const storage = memory();
    const a = harness({ storage });
    a.relay.events.push(version("A's text", T0));
    a.sync.start();
    a.sync.identities(ready([AGENT]));
    a.route("live");
    await flush();
    expect(a.resolve()).toMatchObject({ source: "version", text: "A's text" });
    const store = new InstructionStore(storage);
    expect(store.entry(subjectKey(OTHER, COMMUNITY, AGENT))).toBeUndefined();
    expect(
      resolveInstructions(
        store,
        OTHER,
        COMMUNITY,
        AGENT,
        { linked: false },
        false,
      ),
    ).toEqual({ blocked: "Instructions haven't synced yet" });
    store.signOut(OWNER);
    expect(store.entry(subjectKey(OWNER, COMMUNITY, AGENT))).toBeUndefined();
    expect(store.hadVersion(subjectKey(OWNER, COMMUNITY, AGENT))).toBe(true);
    expect(store.hadVersion(subjectKey(OTHER, COMMUNITY, AGENT))).toBe(false);
  });

  it("T4 a read that completes after abort or a route exit writes nothing", async () => {
    const h = harness();
    h.relay.events.push(version("late", T0));
    let release = () => {};
    h.relay.hold(new Promise<void>((r) => (release = r)));
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    h.route("pending");
    h.relay.hold(undefined);
    release();
    await flush();
    expect(h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT))).toBeUndefined();
    h.controller.abort();
    h.route("live");
    await flush();
    expect(h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT))).toBeUndefined();
  });

  it("T5 a live save published during the scan is the head afterwards", async () => {
    const h = harness();
    h.relay.events.push(version("old", T0));
    let release = () => {};
    h.relay.hold(new Promise<void>((r) => (release = r)));
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    const fresh = version("new", T0 + 5);
    h.push(fresh);
    h.relay.hold(undefined);
    release();
    await flush();
    expect(h.resolve()).toMatchObject({ text: "new", versionId: fresh.id });
  });

  it("T6 a live deletion of the head blocks launch until a re-read installs the previous version", async () => {
    const h = harness();
    const older = version("v1", T0);
    const head = version("v2", T0 + 1);
    h.relay.events.push(older, head);
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    h.relay.fail(true);
    const gone = deletion(head.id);
    h.relay.events.push(gone);
    h.push(gone);
    expect(h.resolve()).toEqual({
      blocked:
        "Instructions changed on another device; loading the current version",
    });
    await flush();
    expect("blocked" in h.resolve()).toBe(true);
    h.relay.fail(false);
    h.push(deletion(head.id));
    h.sync.identities(ready([]));
    h.sync.identities(ready([AGENT]));
    await flush();
    expect(h.resolve()).toMatchObject({ text: "v1", versionId: older.id });
  });

  it("T7 a failed scan never makes a head absent; a complete scan without it does", async () => {
    const h = harness();
    const head = version("v1", T0);
    h.relay.events.push(head);
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    h.relay.events.push(deletion(head.id));
    h.relay.fail(true);
    h.route("pending");
    h.route("live");
    await flush();
    expect(h.resolve()).toMatchObject({ text: "v1" });
    h.relay.fail(false);
    h.route("pending");
    h.route("live");
    await flush();
    expect(h.resolve()).toEqual({ source: "legacy", text: "legacy" });
  });

  it("a complete scan drops a version it no longer returns, even with no deletion seen", async () => {
    const h = harness();
    const v1 = version("v1", T0);
    const v2 = version("v2", T0 + 1);
    h.relay.events.push(v1, v2);
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    expect(h.resolve()).toMatchObject({ versionId: v2.id });
    // Gone from the relay without this device seeing its deletion.
    h.relay.events.splice(h.relay.events.indexOf(v2), 1);
    h.route("pending");
    h.route("live");
    await flush();
    expect(h.resolve()).toMatchObject({ versionId: v1.id });
    expect(h.sync.history(AGENT).map((e) => e.id)).toEqual([v1.id]);
  });

  it("a live version that arrives during a scan survives the scan that missed it", async () => {
    const h = harness();
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    let release = () => {};
    h.relay.hold(new Promise<void>((r) => (release = r)));
    h.route("live");
    await flush();
    const live = version("live", T0 + 5);
    h.push(live);
    await flush();
    h.relay.hold(undefined);
    release();
    await flush();
    expect(h.resolve()).toMatchObject({ versionId: live.id });
  });

  it("a cached head launches from local decode with the relay down", async () => {
    const storage = memory();
    const first = harness({ storage });
    const v1 = version("cached", T0);
    first.relay.events.push(v1);
    first.sync.start();
    first.sync.identities(ready([AGENT]));
    first.route("live");
    await flush();
    first.controller.abort();
    const relay = fakeRelay();
    relay.fail(true);
    const h = harness({ storage, relay });
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    await flush();
    expect(h.resolve()).toEqual({
      source: "version",
      text: "cached",
      versionId: v1.id,
    });
    expect(relay.reads).toHaveLength(0);
  });

  it("a cached head that fails verification blocks instead of launching", async () => {
    const storage = memory();
    const first = harness({ storage });
    first.relay.events.push(version("cached", T0));
    first.sync.start();
    first.sync.identities(ready([AGENT]));
    first.route("live");
    await flush();
    first.controller.abort();
    const h = harness({ storage });
    h.decode.mockImplementation(async () => []);
    h.sync.start();
    await flush();
    expect(h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT))?.head).toEqual({
      unknown: true,
    });
    expect(h.resolve()).toHaveProperty("blocked");
  });

  it("a scan is complete only after each subject's head is installed", async () => {
    const h = harness();
    const v1 = version("v1", T0);
    h.relay.events.push(v1);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const decode = h.decode.getMockImplementation();
    h.decode.mockImplementation(async (subject, events) => {
      await held;
      return decode?.(subject, events) ?? [];
    });
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    // Never the legacy fallback while the returned version is decoding.
    expect(h.resolve()).toHaveProperty("blocked");
    expect(h.store.scanned(OWNER, COMMUNITY)).toBeUndefined();
    release();
    await flush();
    expect(h.resolve()).toMatchObject({ versionId: v1.id });
    expect(h.store.scanned(OWNER, COMMUNITY)).toBeDefined();
  });

  it("a deletion of a version the running scan returned is admitted before it merges", async () => {
    const h = harness();
    const v1 = version("v1", T0);
    h.relay.events.push(v1);
    let release = () => {};
    const read = h.relay.read.bind(h.relay);
    h.relay.read = async (filters) => {
      if (filters[0]?.kinds?.includes(5))
        await new Promise<void>((r) => (release = r));
      return read(filters);
    };
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    expect(h.admits(v1.id)).toBe(true);
    expect(h.admits("f".repeat(64))).toBe(false);
    release();
    await flush();
  });

  it("T8 an older re-read finishing after a newer live head does not overwrite it", async () => {
    const h = harness();
    h.relay.events.push(version("v1", T0));
    h.sync.start();
    h.sync.identities(ready([AGENT]));
    h.route("live");
    await flush();
    let release = () => {};
    h.relay.hold(new Promise<void>((r) => (release = r)));
    h.sync.identities(ready([]));
    h.sync.identities(ready([AGENT]));
    const newer = version("v2", T0 + 9);
    h.push(newer);
    await flush();
    h.relay.hold(undefined);
    release();
    await flush();
    expect(h.resolve()).toMatchObject({ versionId: newer.id });
  });

  describe("T11 save recovery", () => {
    const setup = async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      h.route("live");
      await flush();
      return h;
    };
    const pending = (h: ReturnType<typeof harness>) =>
      h.sync.pendingSave(AGENT);

    it("re-sends the same bytes inside the window; duplicate means stored", async () => {
      const h = await setup();
      h.box.answer = "lose";
      const saved = await h.sync.save(AGENT, "text", undefined);
      await flush();
      expect(saveState(pending(h) as OutgoingEvent, T0)).toMatchObject({
        state: "uncertain",
        expired: false,
      });
      h.box.answer = "accept";
      await h.sync.recover();
      await flush();
      expect(h.box.sends.map((e) => e.id)).toEqual([saved, saved]);
    });

    it("after the window reads by id only and never re-sends", async () => {
      const h = await setup();
      h.box.answer = "lose";
      const saved = await h.sync.save(AGENT, "text", undefined);
      await flush();
      h.advance(RESEND_WINDOW_SECONDS + 1);
      await h.sync.recover();
      await flush();
      expect(h.box.sends).toHaveLength(1);
      expect(pending(h)).toBeUndefined();
      expect(h.relay.reads.at(-1)?.[0]?.ids).toEqual([saved]);
    });

    it("missing after the window stays couldn't-confirm; a read failure keeps waiting", async () => {
      const h = await setup();
      h.box.answer = "drop";
      await h.sync.save(AGENT, "text", undefined);
      await flush();
      h.advance(RESEND_WINDOW_SECONDS + 1);
      await h.sync.recover();
      expect(
        saveState(pending(h) as OutgoingEvent, T0 + RESEND_WINDOW_SECONDS + 1),
      ).toMatchObject({
        state: "uncertain",
        expired: true,
      });
      h.relay.fail(true);
      await expect(h.sync.recover()).rejects.toThrow("offline");
      expect(pending(h)).toBeDefined();
      expect(h.box.sends).toHaveLength(1);
      h.relay.fail(false);
      h.box.answer = "accept";
      const again = await h.sync.save(AGENT, "text", undefined);
      expect(again).not.toBe(h.box.sends[0]?.id);
    });

    it("a refused re-send keeps couldn't-confirm; the late original clears it with nothing sent", async () => {
      const h = await setup();
      h.box.answer = "drop";
      const saved = await h.sync.save(AGENT, "text", undefined);
      await flush();
      h.box.answer = "restricted: scope";
      await h.sync.recover();
      await flush();
      expect(saveState(pending(h) as OutgoingEvent, T0)).toEqual({
        state: "uncertain",
        reason: "restricted: scope",
        expired: false,
      });
      const original = h.box.sends[0] as RelayEvent;
      h.relay.events.push(original);
      h.advance(RESEND_WINDOW_SECONDS + 1);
      const sent = h.box.sends.length;
      h.route("pending");
      h.route("live");
      await flush();
      expect(pending(h)).toBeUndefined();
      expect(h.box.sends).toHaveLength(sent);
      expect(h.resolve()).toMatchObject({ versionId: saved });
    });

    it("an error: answer is uncertain; only a refused first send is rejected", async () => {
      const h = await setup();
      h.box.answer = "error: database";
      await h.sync.save(AGENT, "one", undefined);
      await flush();
      expect(saveState(pending(h) as OutgoingEvent, T0).state).toBe(
        "uncertain",
      );
      await h.box.outbox.dismiss(pending(h)?.event.id ?? "");
      h.box.answer = "blocked: too large";
      await h.sync.save(AGENT, "two", undefined);
      await flush();
      expect(saveState(pending(h) as OutgoingEvent, T0)).toEqual({
        state: "rejected",
        reason: "blocked: too large",
      });
    });

    it("keeps the save-conflict check", async () => {
      const h = await setup();
      h.relay.events.push(version("other device", T0));
      await expect(
        h.sync.save(AGENT, "mine", undefined),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it("a failed store write changes nothing a retry would skip", () => {
    const storage = memory();
    const store = new InstructionStore(storage);
    const key = subjectKey(OWNER, COMMUNITY, AGENT);
    storage.fail = INSTRUCTIONS_STORE_KEY;
    expect(() => store.stage(key, "text", "intent")).toThrow("quota");
    expect(store.entry(key)).toBeUndefined();
    storage.fail = HAD_VERSION_KEY;
    expect(() => store.markHadVersion(key)).toThrow("quota");
    expect(store.hadVersion(key)).toBe(false);
    storage.fail = undefined;
    store.stage(key, "text", "intent");
    store.markHadVersion(key);
    const reloaded = new InstructionStore(storage);
    expect(reloaded.entry(key)?.migration).toMatchObject({ text: "text" });
    expect(reloaded.hadVersion(key)).toBe(true);
  });

  describe("migration", () => {
    const staged = (
      h: ReturnType<typeof harness>,
      text: string,
      agent = AGENT,
    ) =>
      h.store.write(subjectKey(OWNER, COMMUNITY, agent), {
        head: { unknown: true },
        migration: { state: "staged", text, sourceRevision: "r1" },
      });

    it("T12 confirms the published event by id, then strips", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      staged(h, "plugin text");
      const strip = vi.fn(async () => {});
      await h.sync.migrate(AGENT, strip);
      expect(strip).toHaveBeenCalledOnce();
      expect(
        h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT))?.migration.state,
      ).toBe("done");
      const eventId = h.box.sends[0]?.id;
      expect(h.relay.reads.at(-1)?.[0]?.ids).toEqual([eventId]);
    });

    it("T12 a crash between publish and strip resumes by confirming the same id", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      const event = version("plugin text", T0);
      h.relay.events.push(event);
      h.store.write(subjectKey(OWNER, COMMUNITY, AGENT), {
        head: { unknown: true },
        migration: {
          state: "staged",
          text: "plugin text",
          sourceRevision: "r1",
          eventId: event.id,
        },
      });
      const strip = vi.fn(async () => {});
      await h.sync.migrate(AGENT, strip);
      expect(h.box.sends).toHaveLength(0);
      expect(strip).toHaveBeenCalledOnce();
    });

    /** Holds only the exact-id read that confirms a migration. */
    const holdConfirm = (h: ReturnType<typeof harness>) => {
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const read = h.relay.read.bind(h.relay);
      h.relay.read = async (filters) => {
        if (filters[0]?.ids) await gate;
        return read(filters);
      };
      return () => release();
    };

    it("a confirmation read held across Delete Agent never recreates the entry", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      h.route("live");
      await flush();
      staged(h, "plugin text");
      const release = holdConfirm(h);
      const strip = vi.fn(async () => {});
      const sent = h.sync.migrate(AGENT, strip);
      await vi.waitFor(() => expect(h.box.sends).toHaveLength(1));
      await flush();
      h.sync.identities(ready([], [AGENT]));
      h.store.forget(subjectKey(OWNER, COMMUNITY, AGENT));
      release();
      await sent;
      expect(strip).not.toHaveBeenCalled();
      expect(
        h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT)),
      ).toBeUndefined();
      expect(h.store.hadVersion(subjectKey(OWNER, COMMUNITY, AGENT))).toBe(
        false,
      );
    });

    it("a held migration confirmation never replaces a newer remote head", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      h.route("live");
      await flush();
      staged(h, "plugin text");
      const release = holdConfirm(h);
      const run = h.sync.migrate(AGENT, async () => {});
      await vi.waitFor(() => expect(h.box.sends).toHaveLength(1));
      const newer = version("from another device", T0 + 100);
      h.relay.events.push(newer);
      h.push(newer);
      release();
      await run;
      await flush();
      expect(h.resolve()).toEqual({
        source: "version",
        text: "from another device",
        versionId: newer.id,
      });
    });

    it("T13 a refused publish keeps the staged text launchable", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      staged(h, "plugin text");
      h.route("live");
      await flush();
      h.box.answer = "blocked: nope";
      const strip = vi.fn(async () => {});
      await expect(h.sync.migrate(AGENT, strip)).rejects.toThrow();
      expect(strip).not.toHaveBeenCalled();
      expect(h.resolve()).toEqual({ source: "local", text: "plugin text" });
    });

    it("T15 divergent text after a version was seen becomes a draft, not published or stripped", async () => {
      const h = harness();
      h.relay.events.push(version("remote", T0));
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      h.route("live");
      await flush();
      h.store.write(subjectKey(OWNER, COMMUNITY, AGENT), {
        head: h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT))?.head ?? {
          unknown: true,
        },
        migration: { state: "staged", text: "local", sourceRevision: "r1" },
      });
      const strip = vi.fn(async () => {});
      await h.sync.migrate(AGENT, strip);
      expect(h.box.sends).toHaveLength(0);
      expect(strip).not.toHaveBeenCalled();
      expect(h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT))?.draft).toBe(
        "local",
      );
      expect(h.resolve()).toMatchObject({ text: "remote" });
    });

    it("T16 done plus every version deleted never re-imports plugin text", async () => {
      const h = harness();
      h.store.write(subjectKey(OWNER, COMMUNITY, AGENT), {
        head: { absent: true, scanId: 1 },
        migration: { state: "done", eventId: "e" },
      });
      h.store.markHadVersion(subjectKey(OWNER, COMMUNITY, AGENT));
      h.sync.identities(ready([AGENT]));
      const strip = vi.fn(async () => {});
      await h.sync.migrate(AGENT, strip);
      expect(h.box.sends).toHaveLength(0);
      expect(h.resolve()).toEqual({ source: "legacy", text: "legacy" });
    });

    it("T14 a config edit during migration becomes a recoverable draft, not stripped", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      h.store.write(subjectKey(OWNER, COMMUNITY, AGENT), {
        head: { unknown: true },
        migration: {
          state: "staged",
          text: "plugin text",
          sourceRevision: hash("plugin text"),
        },
      });
      let configured = "plugin text";
      const strip = vi.fn(async () => {});
      const run = h.sync.migrate(AGENT, strip, () => configured);
      configured = "edited meanwhile";
      await run;
      expect(strip).not.toHaveBeenCalled();
      const entry = h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT));
      expect(entry?.draft).toBe("edited meanwhile");
      expect(h.box.sends.map((e) => e.content)).toEqual(["c:plugin text"]);
      // Unchanged config strips as before.
      h.store.write(subjectKey(OWNER, COMMUNITY, AGENT2), {
        head: { unknown: true },
        migration: {
          state: "staged",
          text: "two",
          sourceRevision: hash("two"),
        },
      });
      h.sync.identities(ready([AGENT, AGENT2]));
      await h.sync.migrate(AGENT2, strip, () => "two");
      expect(strip).toHaveBeenCalledOnce();
    });

    it("T29 publishes one agent at a time", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT, AGENT2]));
      staged(h, "one");
      staged(h, "two", AGENT2);
      let first = () => {};
      const strips = [
        vi.fn(() => new Promise<void>((r) => (first = r))),
        vi.fn(async () => {}),
      ];
      const a = h.sync.migrate(AGENT, strips[0] as () => Promise<void>);
      const b = h.sync.migrate(AGENT2, strips[1] as () => Promise<void>);
      await flush();
      expect(h.box.sends).toHaveLength(1);
      first();
      await Promise.all([a, b]);
      expect(h.box.sends).toHaveLength(2);
    });
  });

  describe("T17 launch resolution", () => {
    const store = () => new InstructionStore(memory());
    const key = subjectKey(OWNER, COMMUNITY, AGENT);
    const resolve = (
      s: InstructionStore,
      fallback = { linked: false, legacy: "legacy" } as never,
    ) => resolveInstructions(s, OWNER, COMMUNITY, AGENT, fallback);

    it("distinguishes an empty version, an invalid one and absence", () => {
      const s = store();
      const empty = version("", T0);
      s.write(key, { head: { event: empty }, migration: { state: "never" } });
      expect(resolve(s)).toEqual({
        blocked: "Instructions haven't synced yet",
      });
      s.remember(empty.id, { text: "" });
      expect(resolve(s)).toMatchObject({ source: "version", text: "" });
      s.remember(empty.id, { invalid: "Can't read this version" });
      expect(resolve(s)).toEqual({ blocked: "Can't read this version" });
      s.write(key, {
        head: { absent: true, scanId: 1 },
        migration: { state: "never" },
      });
      expect(resolve(s)).toEqual({ source: "legacy", text: "legacy" });
    });

    it("walks local, linked definition, legacy and none in order", () => {
      const s = store();
      s.write(key, {
        head: { absent: true, scanId: 1 },
        migration: { state: "staged", text: "B", sourceRevision: "r" },
      });
      expect(resolve(s, { linked: true, definition: "A" } as never)).toEqual({
        source: "local",
        text: "B",
      });
      s.write(key, {
        head: { absent: true, scanId: 1 },
        migration: { state: "staged", text: "", sourceRevision: "r" },
      });
      expect(resolve(s)).toEqual({ source: "local", text: "" });
      s.write(key, {
        head: { absent: true, scanId: 1 },
        migration: { state: "never" },
        draft: "draft",
      });
      expect(resolve(s, { linked: true, definition: "A" } as never)).toEqual({
        source: "definition",
        text: "A",
      });
      expect(resolve(s, { linked: true } as never)).toEqual({
        blocked: "Definition not synced",
      });
      expect(resolve(s, { linked: false } as never)).toEqual({
        source: "none",
        text: "",
      });
      expect(
        resolveInstructions(s, OWNER, COMMUNITY, AGENT, undefined),
      ).toEqual({ blocked: "Agent record not synced" });
    });

    it("never launches old local text once a version was seen, across restart and sign-out", () => {
      const storage = memory();
      const s = new InstructionStore(storage);
      s.markHadVersion(key);
      s.signOut(OWNER);
      const back = new InstructionStore(storage);
      back.write(key, {
        head: { absent: true, scanId: 2 },
        migration: {
          state: "staged",
          text: "B's old text",
          sourceRevision: "r",
        },
      });
      expect(resolve(back)).toEqual({ source: "legacy", text: "legacy" });
      back.forget(key);
      expect(back.hadVersion(key)).toBe(false);
    });

    it("a failed fetch stays blocked, never treated as no versions", () => {
      const s = store();
      s.write(key, { head: { unknown: true }, migration: { state: "never" } });
      expect(resolve(s)).toEqual({
        blocked: "Instructions haven't synced yet",
      });
    });
  });

  describe("Delete Agent", () => {
    const setup = async (storage = memory()) => {
      const h = harness({ storage });
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      h.route("live");
      await flush();
      return h;
    };
    const kind5 = (h: ReturnType<typeof harness>) =>
      h.box.sends.filter((e) => e.kind === 5);

    it("T18 sweeps every version, leaves other subjects, and forgets only after an empty final page", async () => {
      const h = await setup();
      for (let i = 0; i < 150; i++)
        h.relay.events.push(version(`v${i}`, T0 - i));
      h.relay.events.push(version("team", T0, AGENT2));
      await h.sync.deleteAgent(AGENT);
      expect(kind5(h)).toHaveLength(150);
      expect(
        h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT)),
      ).toBeUndefined();
      expect(
        await h.relay.read([
          { kinds: [INSTRUCTIONS_KIND], "#p": [AGENT2], limit: 5 },
        ]),
      ).toHaveLength(1);
    });

    it("T19 a failure mid-sweep throws and a retry restarts from enumeration", async () => {
      const h = await setup();
      for (let i = 0; i < 3; i++) h.relay.events.push(version(`v${i}`, T0 - i));
      h.store.write(subjectKey(OWNER, COMMUNITY, AGENT), {
        head: { unknown: true },
        migration: { state: "never" },
      });
      h.box.answer = "blocked: later";
      await expect(h.sync.deleteAgent(AGENT)).rejects.toThrow();
      expect(h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT))).toBeDefined();
      h.box.answer = "accept";
      await h.sync.deleteAgent(AGENT);
      expect(
        await h.relay.read([
          { kinds: [INSTRUCTIONS_KIND], "#p": [AGENT], limit: 5 },
        ]),
      ).toHaveLength(0);
      expect(
        h.store.entry(subjectKey(OWNER, COMMUNITY, AGENT)),
      ).toBeUndefined();
    });

    it("T27 settles each outbox entry by its proof and never re-sends", async () => {
      const h = await setup();
      h.box.answer = "accept";
      const accepted = await h.sync.save(AGENT, "a", undefined);
      await flush();
      // Accepted but already invisible to an exact-id read: still deleted.
      h.relay.events.splice(
        h.relay.events.findIndex((e) => e.id === accepted),
        1,
      );
      h.box.answer = "drop";
      const lost = await h.sync.save(AGENT, "b", undefined);
      await flush();
      h.box.answer = "hold";
      const unsent = h.box.outbox.send(
        { kind: INSTRUCTIONS_KIND, content: "c:z", tags: [["p", AGENT]] },
        {
          key: recoveryKey(OWNER, COMMUNITY, AGENT),
          value: "{}",
        },
      );
      h.box.settlements.set(unsent, "unsent");
      await flush();
      h.box.answer = "accept";
      const sendsBefore = h.box.sends.filter(
        (e) => e.kind === INSTRUCTIONS_KIND,
      ).length;
      await h.sync.deleteAgent(AGENT);
      await flush();
      expect(
        h.box.sends.filter((e) => e.kind === INSTRUCTIONS_KIND).length,
      ).toBeLessThanOrEqual(sendsBefore + 1);
      expect(
        h.box.sends.filter(
          (e) => e.kind === INSTRUCTIONS_KIND && e.id === lost,
        ),
      ).toHaveLength(1);
      expect(kind5(h).map((e) => e.tags[0]?.[1])).toEqual([accepted]);
      expect(h.store.cleanupIds(OWNER, COMMUNITY)).toEqual([lost]);
      expect(
        h.box.outbox
          .snapshot()
          .filter((i) => i.event.kind === INSTRUCTIONS_KIND),
      ).toHaveLength(0);
      expect(kind5(h).some((e) => e.tags[0]?.[1] === unsent)).toBe(false);
    });

    it("T27 a lost save landing late is deleted by the cleanup sweep after forget; the list survives sign-out", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const storage = memory();
      const h = await setup(storage);
      h.box.answer = "drop";
      const lost = await h.sync.save(AGENT, "b", undefined);
      await flush();
      await h.sync.deleteAgent(AGENT);
      h.sync.identities(ready([], [AGENT]));
      expect(h.store.cleanupIds(OWNER, COMMUNITY)).toEqual([lost]);
      await h.sync.sweepCleanup();
      expect(h.store.cleanupIds(OWNER, COMMUNITY)).toEqual([lost]);
      h.relay.fail(true);
      await expect(h.sync.sweepCleanup()).rejects.toThrow();
      expect(h.store.cleanupIds(OWNER, COMMUNITY)).toEqual([lost]);
      h.relay.fail(false);
      h.store.signOut(OWNER);
      const back = new InstructionStore(storage);
      expect(back.cleanupIds(OWNER, COMMUNITY)).toEqual([lost]);
      expect(back.cleanupIds(OTHER, COMMUNITY)).toEqual([]);
      const late = h.box.sends.find((e) => e.id === lost) as RelayEvent;
      h.relay.events.push(late);
      h.push(late);
      await flush();
      expect(h.sync.history(AGENT)).toEqual([]);
      h.box.answer = "accept";
      await h.sync.sweepCleanup();
      expect(kind5(h).map((e) => e.tags[0]?.[1])).toEqual([lost]);
      expect(h.store.cleanupIds(OWNER, COMMUNITY)).toEqual([]);
      expect(h.box.sends.filter((e) => e.id === lost)).toHaveLength(1);
    });

    it("T27 device B still holding the agent keeps its history and the late version", async () => {
      const relay = fakeRelay();
      const a = harness({ relay });
      const b = harness({ relay });
      for (const d of [a, b]) {
        d.sync.start();
        d.sync.identities(ready([AGENT]));
        d.route("live");
      }
      await flush();
      await a.sync.deleteAgent(AGENT);
      a.sync.identities(ready([], [AGENT]));
      const late = version("late", T0 + 30);
      relay.events.push(late);
      a.push(late);
      b.push(late);
      await flush();
      expect(a.sync.history(AGENT)).toEqual([]);
      expect(
        a.store.entry(subjectKey(OWNER, COMMUNITY, AGENT)),
      ).toBeUndefined();
      expect(b.sync.history(AGENT).map((e) => e.id)).toEqual([late.id]);
      expect(b.resolve()).toMatchObject({ text: "late" });
    });

    it("T27 a failed cleanup-list write keeps the fenced outbox entry for the next attempt", async () => {
      const storage = memory();
      const h = await setup(storage);
      h.box.answer = "drop";
      const lost = await h.sync.save(AGENT, "b", undefined);
      await flush();
      storage.fail = CLEANUP_KEY;
      await expect(h.sync.deleteAgent(AGENT)).rejects.toThrow("quota");
      expect(h.box.outbox.snapshot().map((i) => i.event.id)).toContain(lost);
      await h.sync.recover();
      await flush();
      expect(h.box.sends.filter((e) => e.id === lost)).toHaveLength(1);
      storage.fail = undefined;
      // The cleanup list is durable before the outbox entry is retired.
      const order: string[] = [];
      const setItem = storage.setItem.bind(storage);
      storage.setItem = (key: string, value: string) => {
        if (key === CLEANUP_KEY) order.push("cleanup-list");
        setItem(key, value);
      };
      const retire = h.box.outbox.retire;
      h.box.outbox.retire = async (eventId: string) => {
        order.push(`retire ${eventId === lost ? "lost" : eventId}`);
        await retire(eventId);
      };
      await h.sync.deleteAgent(AGENT);
      expect(order.slice(0, 2)).toEqual(["cleanup-list", "retire lost"]);
      expect(h.store.cleanupIds(OWNER, COMMUNITY)).toEqual([lost]);
      expect(h.box.outbox.snapshot()).toHaveLength(0);
      expect(h.store.hadVersion(subjectKey(OWNER, COMMUNITY, AGENT))).toBe(
        false,
      );
    });
  });

  describe("T30 identity loading is not deletion", () => {
    it("keeps versions while the native list is held, and shows them once it loads", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      const v = version("kept", T0);
      h.relay.events.push(v);
      h.sync.start();
      h.route("live");
      await flush();
      expect(h.sync.history(AGENT).map((e) => e.id)).toEqual([v.id]);
      h.sync.identities(ready([AGENT]));
      await flush();
      expect(h.resolve()).toMatchObject({ text: "kept" });
    });

    it("a failed inventory read discards nothing", async () => {
      const h = harness();
      h.relay.events.push(version("kept", T0));
      h.sync.start();
      h.sync.identities({
        state: "failed",
        known: new Set(),
        deleted: new Set(),
      });
      h.route("live");
      await flush();
      expect(h.resolve()).toMatchObject({ text: "kept" });
    });

    it("an identity added after the scan is read directly on the live route", async () => {
      const h = harness();
      h.sync.start();
      h.sync.identities(ready([AGENT]));
      h.route("live");
      await flush();
      const imported = version("imported", T0, AGENT2);
      h.relay.events.push(imported);
      const reads = h.relay.reads.length;
      h.sync.identities(ready([AGENT, AGENT2]));
      await flush();
      expect(h.relay.reads.length).toBeGreaterThan(reads);
      expect(h.relay.reads[reads]?.[0]?.["#p"]).toEqual([AGENT2]);
      expect(h.resolve(AGENT2)).toMatchObject({ text: "imported" });
    });
  });
});
