import { describe, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import { artifactD, artifactTemplate } from "./agent-config-artifacts";
import {
  type ConfigFeed,
  createConfigSync,
  DISCOVERY_PAGE,
} from "./config-sync";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const relay = keypair();
const agent = keypair().pubkey;
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const binding = { family: "agent-config", subject: agent, channel } as const;
const subject = (type: Subject["type"]): Subject => ({
  owner: owner.pubkey,
  community: "c",
  subject: agent,
  channel,
  type,
});
const instructions = subject("buzz.agent.instructions");
const settings = subject("buzz.agent.settings");

async function revision(
  text: string,
  prev?: string,
  type: Subject["type"] = "buzz.agent.instructions",
  home = channel,
) {
  const d = await artifactD(type, channel);
  return signed(
    owner,
    artifactTemplate({
      channel: home,
      type,
      d,
      op: prev ? "update" : "create",
      title: "Agent instructions",
      content: JSON.stringify(
        type === "buzz.agent.settings"
          ? { version: 1, settings: {} }
          : { version: 1, text },
      ),
      ...(prev ? { prev } : {}),
    }),
  );
}

/** Relay-signed channel state the confirm read returns. */
const metadata = (tags: string[][] = []) =>
  signed(relay, { kind: 39000, content: "", tags: [["d", channel], ...tags] });
const members = (pubkeys = [owner.pubkey]) =>
  signed(relay, {
    kind: 39002,
    content: "",
    tags: [["d", channel], ...pubkeys.map((p) => ["p", p])],
  });

/** A feed whose reads, connections and EOSE the test releases. */
function controlled(
  answer: (filter: ReadFilter) => RelayEvent[] | Promise<RelayEvent[]>,
) {
  type Sub = { filters: readonly ReadFilter[]; open: boolean } & Parameters<
    ConfigFeed["subscribe"]
  >[1];
  const subs: Sub[] = [];
  const reads: ReadFilter[] = [];
  const connections = new Set<(generation: number) => void>();
  let generation = 1;
  const state = {
    channel: (): RelayEvent[] | Promise<RelayEvent[]> => [
      metadata(),
      members(),
    ],
    discovery: (_filter: ReadFilter): RelayEvent[] => [],
  };
  const feed: ConfigFeed = {
    relayAuthor: relay.pubkey,
    generation: () => generation,
    connection(listener) {
      connections.add(listener);
      return () => connections.delete(listener);
    },
    read: async ([filter]) => {
      if (!filter) return [];
      reads.push(filter);
      if (filter["#P"]) return state.discovery(filter);
      if (filter["#d"] && filter.kinds?.includes(39000)) return state.channel();
      return answer(filter);
    },
    subscribe(filters, handlers) {
      const sub: Sub = { filters, open: true, ...handlers };
      subs.push(sub);
      return () => {
        sub.open = false;
      };
    },
  };
  const open = () => subs.filter((s) => s.open);
  const content = () => open().find((s) => s.filters[0]?.["#h"]);
  const roster = () => open().find((s) => s.filters[0]?.["#d"]);
  const discovery = () => open().find((s) => s.filters[0]?.["#P"]);
  /** Once bind has subscribed, the relay reports both established. */
  const eose = async () => {
    await vi.waitFor(() => expect(roster()).toBeDefined());
    content()?.eose(generation);
    roster()?.eose(generation);
  };
  const reconnect = () => {
    generation += 1;
    for (const listener of connections) listener(generation);
  };
  const artifactReads = () => reads.filter((f) => f.kinds?.includes(45010));
  return {
    feed,
    reads,
    artifactReads,
    state,
    subs,
    content,
    roster,
    discovery,
    eose,
    reconnect,
    generation: () => generation,
  };
}

/** A promise the test resolves later. */
function held<T>() {
  let release!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("config sync barrier", () => {
  it("reads only after the subscriptions are established", async () => {
    const head = await revision("A");
    const relayFeed = controlled((f) =>
      f.artifact === "current" ? [head] : [],
    );
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await flush();
    expect(relayFeed.reads).toEqual([]);
    await relayFeed.eose();
    await bound;
    expect(relayFeed.reads[0]).toMatchObject({
      kinds: [39000],
      authors: [relay.pubkey],
      "#d": [channel],
      limit: 1,
      consistency: "strong",
    });
    expect(relayFeed.artifactReads()[0]).toMatchObject({
      artifact: "current",
      "#h": [channel],
    });
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });

  it("keeps an edit that arrives between subscribing and the read", async () => {
    const a = await revision("A");
    const b = await revision("B", a.id);
    const relayFeed = controlled((f) => (f.artifact === "current" ? [a] : []));
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.content()).toBeDefined());
    relayFeed.content()?.event(b);
    await relayFeed.eose();
    await bound;
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
  });

  it("looks up by d when the current read omits an artifact, keeping deleted apart from unavailable", async () => {
    const a = await revision("A");
    const d = await artifactD("buzz.agent.instructions", channel);
    const deletion = signed(owner, {
      kind: 45010,
      content: "",
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", "buzz.agent.instructions"],
        ["op", "delete"],
        ["prev", a.id],
      ],
    });
    const relayFeed = controlled((f) => (f["#d"]?.[0] === d ? [deletion] : []));
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await flush();
    await relayFeed.eose();
    await bound;
    expect(relayFeed.artifactReads()).toContainEqual(
      expect.objectContaining({ "#h": [channel], "#d": [d] }),
    );
    expect(store.state(instructions).state).toBe("deleted");
    // Nothing anywhere is unavailable, never absent.
    expect(store.state(settings).state).toBe("unavailable");
  });

  it("installs a returned revision from another channel or type as invalid, never present", async () => {
    const d = await artifactD("buzz.agent.instructions", channel);
    const forged = signed(owner, {
      kind: 45010,
      content: JSON.stringify({ version: 1, settings: {} }),
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", "buzz.agent.settings"],
        ["title", "Agent settings"],
        ["op", "create"],
      ],
    });
    const relayFeed = controlled((f) =>
      f.artifact === "current" ? [forged] : [],
    );
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await flush();
    await relayFeed.eose();
    await bound;
    expect(store.state(instructions)).toMatchObject({
      state: "invalid",
      problem: "Artifact type mismatch",
    });
  });
});

describe("config sync live apply", () => {
  async function synced() {
    const a = await revision("A");
    let current: RelayEvent[] = [a];
    const relayFeed = controlled((f) =>
      f.artifact === "current" ? current : f["#d"] ? current : [],
    );
    const store = new AgentConfigStore(memoryStorage());
    const history = vi.fn();
    const discovery = vi.fn();
    const roster = vi.fn();
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c", {
      history,
      discovery,
      roster,
    });
    const bound = sync.bind([binding]);
    await flush();
    await relayFeed.eose();
    await bound;
    history.mockClear();
    return {
      a,
      store,
      relayFeed,
      history,
      discovery,
      roster,
      sync,
      setCurrent: (events: RelayEvent[]) => {
        current = events;
      },
    };
  }

  it("redaction of the head makes it unavailable, re-reads, and reloads history", async () => {
    const { a, store, relayFeed, history, setCurrent } = await synced();
    setCurrent([]);
    const reads = relayFeed.reads.length;
    relayFeed.content()?.event(
      signed(owner, {
        kind: 9005,
        content: "",
        tags: [
          ["h", channel],
          ["e", a.id],
        ],
      }),
    );
    await flush();
    expect(store.state(instructions).state).toBe("unavailable");
    expect(relayFeed.reads.length).toBeGreaterThan(reads);
    expect(history).toHaveBeenCalledWith(
      channel,
      await artifactD("buzz.agent.instructions", channel),
    );
  });

  it("a new revision reloads history; a non-successor asks for a read instead", async () => {
    const { a, store, relayFeed, history } = await synced();
    const b = await revision("B", a.id);
    relayFeed.content()?.event(b);
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "B" });
    expect(history).toHaveBeenCalledTimes(1);
    const stray = await revision("C", "f".repeat(64));
    const reads = relayFeed.reads.length;
    relayFeed.content()?.event(stray);
    await flush();
    expect(relayFeed.reads.length).toBeGreaterThan(reads);
  });

  it("a live successor that fails the artifact checks installs as invalid, never present", async () => {
    const { a, store, relayFeed, setCurrent } = await synced();
    const forged = signed(
      owner,
      artifactTemplate({
        channel,
        type: "buzz.agent.settings",
        d: await artifactD("buzz.agent.instructions", channel),
        op: "update",
        title: "Agent settings",
        content: JSON.stringify({ version: 1, settings: {} }),
        prev: a.id,
      }),
    );
    setCurrent([forged]);
    relayFeed.content()?.event(forged);
    await flush();
    expect(store.state(instructions)).toMatchObject({
      state: "invalid",
      problem: "Artifact type mismatch",
    });
  });

  it("a relay move-removal naming the cached head retires it; an older one re-reads instead", async () => {
    const { a, store, relayFeed } = await synced();
    const d = await artifactD("buzz.agent.instructions", channel);
    const removal = (by: typeof owner, prev: string) =>
      signed(by, {
        kind: 45011,
        content: "",
        tags: [
          ["ar", "1"],
          ["d", d],
          ["h", channel],
          ["reason", "moved"],
          ["prev", prev],
        ],
      });
    const reads = relayFeed.reads.length;
    relayFeed.content()?.event(removal(relay, "e".repeat(64)));
    expect(store.state(instructions).state).toBe("present");
    await flush();
    expect(relayFeed.reads.length).toBeGreaterThan(reads);
    relayFeed.content()?.event(removal(owner, a.id));
    expect(store.state(instructions).state).toBe("present");
    relayFeed.content()?.event(removal(relay, a.id));
    expect(store.state(instructions).state).toBe("unavailable");
  });

  it("archived relay metadata retires the binding and asks the caller to reselect", async () => {
    const { store, relayFeed, discovery } = await synced();
    const before = store.capture(instructions).generation;
    const archived = signed(relay, {
      kind: 39000,
      content: "",
      tags: [
        ["d", channel],
        ["archived", "true"],
      ],
    });
    // Metadata from anyone but the relay is ignored.
    relayFeed
      .roster()
      ?.event(signed(owner, { ...archived, tags: archived.tags }));
    expect(store.state(instructions).state).toBe("present");
    relayFeed.roster()?.event(archived);
    expect(store.state(instructions).state).toBe("unavailable");
    expect(store.capture(instructions).generation).toBe(before + 1);
    expect(discovery).toHaveBeenCalledWith(archived);
  });

  it("reports a bound channel's member change while the owner stays in it", async () => {
    const { store, relayFeed, roster } = await synced();
    relayFeed.roster()?.event(await members([owner.pubkey, agent]));
    expect(roster).toHaveBeenCalledWith(channel);
    expect(store.state(instructions).state).toBe("present");
  });

  it("reports a config channel it does not hold from live discovery", async () => {
    const { relayFeed, discovery } = await synced();
    const other = signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", "5f0c3a5e-1a1b-4c2d-9e8f-001122334455"]],
    });
    relayFeed.discovery()?.event(other);
    expect(discovery).toHaveBeenCalledWith(other);
  });
});

describe("config sync binding lifetime", () => {
  async function bindHeld() {
    const a = await revision("A");
    const read = held<RelayEvent[]>();
    const relayFeed = controlled((f) =>
      f.artifact === "current" ? read.promise : [],
    );
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await relayFeed.eose();
    await vi.waitFor(() => expect(relayFeed.artifactReads()).toHaveLength(1));
    return { a, read, relayFeed, store, sync, bound };
  }

  it("a read held across unbind never installs", async () => {
    const { a, read, store, sync, bound } = await bindHeld();
    sync.unbind(channel);
    read.release([a]);
    await bound;
    expect(store.state(instructions).state).toBe("unavailable");
  });

  it("a read held across dispose never installs", async () => {
    const { a, read, store, sync, bound, relayFeed } = await bindHeld();
    sync.dispose();
    read.release([a]);
    await bound;
    expect(store.state(instructions).state).toBe("unavailable");
    expect(relayFeed.subs.every((s) => !s.open)).toBe(true);
  });

  it("an event queued during the barrier is dropped when the binding retires", async () => {
    const { a, read, store, sync, bound, relayFeed } = await bindHeld();
    const content = relayFeed.content();
    content?.event(await revision("B", a.id));
    sync.unbind(channel);
    read.release([a]);
    await bound;
    content?.event(await revision("C", a.id));
    expect(store.state(instructions).state).toBe("unavailable");
  });

  it("a reread started before unbind cannot install after it", async () => {
    const a = await revision("A");
    let next: RelayEvent[] | Promise<RelayEvent[]> = [a];
    const relayFeed = controlled(() => next);
    const store = new AgentConfigStore(memoryStorage());
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c");
    const bound = sync.bind([binding]);
    await relayFeed.eose();
    await bound;
    const reread = held<RelayEvent[]>();
    next = reread.promise;
    const reads = relayFeed.artifactReads().length;
    relayFeed.content()?.event(await revision("C", "f".repeat(64)));
    await vi.waitFor(() =>
      expect(relayFeed.artifactReads().length).toBeGreaterThan(reads),
    );
    sync.unbind(channel);
    reread.release([await revision("B", a.id)]);
    await flush();
    expect(store.state(instructions).state).toBe("unavailable");
    // Binding again starts a new lifetime that the old reread cannot touch.
    next = [a];
    const again = sync.bind([binding]);
    await relayFeed.eose();
    await again;
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });
});

describe("config sync reconnect barrier", () => {
  async function synced() {
    const a = await revision("A");
    let current: RelayEvent[] = [a];
    const relayFeed = controlled(() => current);
    const store = new AgentConfigStore(memoryStorage());
    const discovery = vi.fn();
    const problem = vi.fn();
    const rediscovered = vi.fn();
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c", {
      discovery,
      problem,
      rediscovered,
    });
    const bound = sync.bind([binding]);
    await relayFeed.eose();
    await bound;
    return {
      a,
      store,
      relayFeed,
      discovery,
      problem,
      rediscovered,
      setCurrent: (events: RelayEvent[]) => {
        current = events;
      },
    };
  }

  it("reads again only once the new connection's subscriptions are established", async () => {
    const { a, store, relayFeed, setCurrent } = await synced();
    const b = await revision("B", a.id);
    setCurrent([b]);
    const reads = relayFeed.artifactReads().length;
    relayFeed.reconnect();
    await flush();
    expect(relayFeed.artifactReads()).toHaveLength(reads);
    // Live events on the new connection wait in the buffer.
    relayFeed.content()?.event(await revision("C", b.id));
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    await relayFeed.eose();
    await vi.waitFor(() =>
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "C" }),
    );
  });

  it("a channel archived while disconnected retires on the strong confirm", async () => {
    const { store, relayFeed, discovery } = await synced();
    relayFeed.state.channel = () => [
      metadata([["archived", "true"]]),
      members(),
    ];
    relayFeed.reconnect();
    await relayFeed.eose();
    await vi.waitFor(() =>
      expect(store.state(instructions).state).toBe("unavailable"),
    );
    expect(discovery).toHaveBeenCalled();
    expect(relayFeed.content()).toBeUndefined();
  });

  it("strongly rediscovers config channels created while disconnected", async () => {
    const { relayFeed, discovery } = await synced();
    const created = signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", "5f0c3a5e-1a1b-4c2d-9e8f-001122334455"]],
    });
    relayFeed.state.discovery = () => [created];
    relayFeed.reconnect();
    await vi.waitFor(() => expect(discovery).toHaveBeenCalledWith(created));
  });

  // The fake feed skips verification, so unsigned shapes keep these fast.
  const channelsAt = (createdAt: (i: number) => number) =>
    Array.from(
      { length: DISCOVERY_PAGE + 1 },
      (_, i) =>
        ({
          id: String(i).padStart(64, "0"),
          pubkey: relay.pubkey,
          kind: 39000,
          content: "",
          created_at: createdAt(i),
          tags: [
            ["d", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`],
          ],
          sig: "",
        }) as unknown as RelayEvent,
    ).reverse();

  it("rediscovery past one created_at page is partial and keeps bindings", async () => {
    const { relayFeed, discovery, rediscovered, problem, store } =
      await synced();
    const channels = channelsAt(() => 1_000_000);
    relayFeed.state.discovery = () => channels.slice(0, DISCOVERY_PAGE);
    rediscovered.mockClear();
    discovery.mockClear();
    relayFeed.reconnect();
    await relayFeed.eose();
    await vi.waitFor(() => expect(rediscovered).toHaveBeenCalledWith(false));
    expect(rediscovered).not.toHaveBeenCalledWith(true);
    expect(discovery).toHaveBeenCalledTimes(DISCOVERY_PAGE);
    expect(problem).not.toHaveBeenCalled();
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  });

  it("rediscovery pages back by until past the relay's page clamp", async () => {
    const { relayFeed, discovery, rediscovered } = await synced();
    const channels = channelsAt((i) => 1_000_000 + i);
    const pages: ReadFilter[] = [];
    relayFeed.state.discovery = (filter) => {
      pages.push(filter);
      expect(filter.limit).toBe(DISCOVERY_PAGE);
      return channels
        .filter(
          (e) => filter.until === undefined || e.created_at <= filter.until,
        )
        .slice(0, DISCOVERY_PAGE);
    };
    discovery.mockClear();
    relayFeed.reconnect();
    await vi.waitFor(() =>
      expect(discovery).toHaveBeenCalledTimes(DISCOVERY_PAGE + 1),
    );
    expect(pages.map((f) => f.until)).toEqual([undefined, 1_000_001]);
    expect(rediscovered).toHaveBeenLastCalledWith(true);
  });

  it("a closed subscription settles bind and reports stale; the next connection recovers", async () => {
    const a = await revision("A");
    const relayFeed = controlled(() => [a]);
    const store = new AgentConfigStore(memoryStorage());
    const problem = vi.fn();
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c", {
      problem,
    });
    const bound = sync.bind([binding]);
    await vi.waitFor(() => expect(relayFeed.content()).toBeDefined());
    relayFeed.content()?.closed(relayFeed.generation(), "error: quota");
    await bound;
    expect(problem).toHaveBeenCalledWith({
      channel,
      kind: "stale",
      error: "error: quota",
    });
    expect(relayFeed.artifactReads()).toHaveLength(0);
    relayFeed.reconnect();
    await relayFeed.eose();
    await vi.waitFor(() =>
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" }),
    );
  });
});

describe("config sync read errors", () => {
  async function seeded() {
    const a = await revision("A");
    let fail: unknown;
    const relayFeed = controlled(() => {
      if (fail) throw fail;
      return [a];
    });
    const store = new AgentConfigStore(memoryStorage());
    const problem = vi.fn();
    const sync = createConfigSync(store, relayFeed.feed, owner.pubkey, "c", {
      problem,
    });
    const bound = sync.bind([binding]);
    await relayFeed.eose();
    await bound;
    expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    return {
      store,
      relayFeed,
      problem,
      failWith: (error: unknown) => {
        fail = error;
      },
    };
  }

  it("a denied read retires the binding, so the seeded head cannot start", async () => {
    const { store, relayFeed, problem, failWith } = await seeded();
    failWith(new Error("Relay read failed (403)"));
    relayFeed.reconnect();
    await relayFeed.eose();
    await vi.waitFor(() =>
      expect(problem).toHaveBeenCalledWith({ channel, kind: "denied" }),
    );
    expect(store.instructions(instructions).ok).toBe(false);
    expect(relayFeed.content()).toBeUndefined();
  });

  it("a transport failure keeps the seeded head, reports stale and retries a bounded number of times", async () => {
    vi.useFakeTimers();
    try {
      const { store, relayFeed, problem, failWith } = await seeded();
      failWith(new Error("Relay response was interrupted"));
      const reads = relayFeed.artifactReads().length;
      relayFeed.reconnect();
      await relayFeed.eose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(relayFeed.artifactReads().length - reads).toBe(4);
      expect(problem).toHaveBeenCalledWith({
        channel,
        kind: "stale",
        error: "Relay response was interrupted",
      });
      expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
      expect(relayFeed.content()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
