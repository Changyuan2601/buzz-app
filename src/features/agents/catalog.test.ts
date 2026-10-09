import { afterEach, describe, expect, it } from "vitest";
import { byteSize, OUTBOX_INPUT_MAX_BYTES } from "../relay/budget.ts";
import type { RelayEvent } from "../relay/events.ts";
import { createOutbox } from "../relay/outbox.ts";
import { createRelayReader } from "../relay/reader.ts";
import type { ReadTransport } from "../relay/transport.ts";
import { flush, keypair, signed, type Key } from "../relay/testing.ts";
import { createCommunityCatalog } from "./catalog.ts";
import { bytes, MAX_CONTENT_BYTES } from "./catalog-envelope.ts";
import { catalogRelay as relay, memoryStorage } from "./catalog-testing.ts";

const alice = keypair(),
  bob = keypair();
const agentBody = (name: string, extra: object = {}) =>
  JSON.stringify({
    display_name: name,
    system_prompt: `Be ${name}.`,
    ...extra,
  });
const teamBody = (name: string) =>
  JSON.stringify({
    v: 1,
    name,
    members: [
      { member_key: "k1", display_name: "Mate", system_prompt: "Help." },
    ],
  });

const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function client(
  server: ReturnType<typeof relay>,
  as: Key,
  storage = memoryStorage(),
  replica?: (events: readonly RelayEvent[]) => readonly RelayEvent[],
) {
  const writes = createOutbox(as.pubkey, server.writer(as), storage, {
    timeoutMs: 1_000,
  });
  const base = server.reader(as);
  const link = { down: false };
  const catalog = createCommunityCatalog({
    // Mirrors the session's verified reader, which reconciles the journal.
    reader: {
      async read(...args: Parameters<typeof base.read>) {
        if (link.down) throw new Error("offline");
        const events = await base.read(...args);
        // Only strong reads are writer-backed; others may hit a replica.
        const result =
          args[0][0]?.consistency === "strong"
            ? events
            : (replica?.(events) ?? events);
        writes.observe(result);
        return result;
      },
    },
    viewer: as.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  return { writes, catalog: catalog.queries, owner: catalog, link };
}
/** A client on the production reader, which shares equal in-flight reads.
 * `holdNext` answers the next coordinate read with the relay state at the
 * time it was issued, but only once released. */
function coalescingClient(server: ReturnType<typeof relay>, as: Key) {
  const writer = server.writer(as);
  const writes = createOutbox(
    as.pubkey,
    {
      ...writer,
      publish(event: RelayEvent) {
        publishes++;
        return writer.publish(event);
      },
    },
    memoryStorage(),
    { timeoutMs: 1_000 },
  );
  const base = server.reader(as);
  let gate: Promise<void> | undefined;
  let failing = false;
  let issued = 0;
  let publishes = 0;
  const transport: ReadTransport = {
    viewer: as.pubkey,
    relayAuthor: "relay",
    media: () => undefined,
    async query(filters) {
      const events = await base.read(filters);
      if (!filters[0]?.["#d"]) return events;
      issued++;
      if (failing) {
        failing = false;
        throw new Error("offline");
      }
      const wait = gate;
      gate = undefined;
      await wait;
      return events;
    },
  };
  const owned = createRelayReader(transport);
  const catalog = createCommunityCatalog({
    reader: owned.reader,
    viewer: as.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, owned, { dispose: () => writes.dispose() });
  return {
    writes,
    catalog: catalog.queries,
    issued: () => issued,
    publishes: () => publishes,
    failNext() {
      failing = true;
    },
    holdNext() {
      let release = () => {};
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}
async function settled(writes: ReturnType<typeof createOutbox>, id: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await flush();
    const item = writes.local.snapshot().find((entry) => entry.event.id === id);
    if (item && item.delivery !== "sending") {
      // Accepted heads are confirmed by a strong coordinate read.
      await flush();
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("operation did not settle");
}

it("shrinks oversized relay-readable pages at the same cursor without publishing a partial catalog", async () => {
  const content = JSON.stringify({
    v: 1,
    name: "Relay-sized crew",
    members: Array.from({ length: 10 }, (_, index) => ({
      member_key: `m${index}`,
      display_name: `Mate ${index}`,
      system_prompt: "x".repeat(16_000),
    })),
  });
  const heads = Array.from({ length: 110 }, (_, index) =>
    signed(bob, {
      kind: 30178,
      tags: [
        ["d", `relay-crew-${index}`],
        ["shared", "true"],
      ],
      content,
      created_at: 110 - index,
    }),
  );
  const limits: number[] = [];
  let failSecondPage = true;
  const transport: ReadTransport = {
    viewer: alice.pubkey,
    relayAuthor: "relay",
    media: () => undefined,
    async query(filters) {
      const filter = filters[0];
      if (!filter) throw new Error("missing filter");
      limits.push(filter.limit);
      if (failSecondPage && filter.until !== undefined) {
        failSecondPage = false;
        throw new Error("offline");
      }
      return heads
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until &&
              event.id < (filter.before_id ?? "")),
        )
        .slice(0, filter.limit);
    },
  };
  expect(byteSize(heads.slice(0, 63))).toBeGreaterThan(8 * 1024 * 1024);
  const owned = createRelayReader(transport);
  const catalog = createCommunityCatalog({
    reader: owned.reader,
    viewer: alice.pubkey,
    outbox: undefined,
    local: undefined,
  });
  owners.push(catalog, owned);
  await catalog.queries.refresh();
  expect(catalog.queries.snapshot()).toMatchObject({
    status: "error",
    teams: [],
  });
  await catalog.queries.refresh();
  expect(catalog.queries.snapshot().status).toBe("ready");
  expect(catalog.queries.snapshot().teams).toHaveLength(heads.length);
  expect(limits.slice(0, 2)).toEqual([63, 31]);
});

it("reads large valid team heads through the production finite reader and completes Retry pagination", async () => {
  const content = JSON.stringify({
    v: 1,
    name: "Large crew",
    members: [0, 1, 2].map((index) => ({
      member_key: `m${index}`,
      display_name: `Mate ${index}`,
      system_prompt: "x".repeat(16_000),
    })),
  });
  const heads = Array.from({ length: 200 }, (_, index) =>
    signed(bob, {
      kind: 30178,
      tags: [
        ["d", `crew-${index}`],
        ["shared", "true"],
      ],
      content,
      created_at: 200 - index,
    }),
  );
  const limits: number[] = [];
  expect(byteSize(heads)).toBeGreaterThan(8 * 1024 * 1024);
  let fail = true;
  const transport: ReadTransport = {
    viewer: alice.pubkey,
    relayAuthor: "relay",
    media: () => undefined,
    async query(filters) {
      const filter = filters[0];
      if (!filter) throw new Error("missing filter");
      limits.push(filter.limit);
      if (fail && limits.length === 2) throw new Error("offline");
      return heads
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until &&
              event.id < (filter.before_id ?? "")),
        )
        .slice(0, filter.limit);
    },
  };
  const owned = createRelayReader(transport);
  const catalog = createCommunityCatalog({
    reader: owned.reader,
    viewer: alice.pubkey,
    outbox: undefined,
    local: undefined,
  });
  owners.push(catalog, owned);
  await catalog.queries.refresh();
  expect(catalog.queries.snapshot().status).toBe("error");
  expect(catalog.queries.snapshot().teams).toHaveLength(0);
  fail = false;
  await catalog.queries.refresh();
  expect(catalog.queries.snapshot().status).toBe("ready");
  expect(catalog.queries.snapshot().teams).toHaveLength(heads.length);
  expect(limits.length).toBeGreaterThan(3);
});

it("lists only valid shared heads and lets an unshared head hide older shares", async () => {
  const server = relay();
  const at = (
    created_at: number,
    tags: string[][],
    content: string,
    kind = 30175,
  ) => signed(bob, { kind, tags, content, created_at });
  server.put(
    at(
      1,
      [
        ["d", "helper"],
        ["shared", "true"],
      ],
      agentBody("Helper"),
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "local"],
        ["shared", "true"],
      ],
      agentBody("Local", { acp_command: "/opt/x" }),
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "broken"],
        ["shared", "true"],
      ],
      "{not json",
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "crew"],
        ["shared", "true"],
      ],
      teamBody("Crew"),
      30178,
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "gone"],
        ["shared", "true"],
      ],
      agentBody("Gone"),
    ),
  );
  // Alice reads her own unshared head; the relay withholds nothing from her.
  server.put(
    signed(alice, {
      kind: 30175,
      tags: [["d", "mine"]],
      content: agentBody("Mine"),
    }),
  );
  const { catalog } = client(server, alice);
  await catalog.refresh();
  const snapshot = catalog.snapshot();
  expect(snapshot.status).toBe("ready");
  expect(
    snapshot.agents.map((entry) => entry.agent.displayName).sort(),
  ).toEqual(["Gone", "Helper"]);
  expect(snapshot.teams.map((entry) => entry.name)).toEqual(["Crew"]);
  expect(snapshot.teams[0]?.members[0]?.displayName).toBe("Mate");
  expect(catalog.state(30175, "mine")).toEqual({ shared: false });

  server.put(at(2, [["d", "gone"]], agentBody("Gone")));
  await catalog.refresh();
  expect(
    catalog.snapshot().agents.map((entry) => entry.agent.displayName),
  ).toEqual(["Helper"]);
});

it("one owner shares and unshares; another reader discovers then loses it", async () => {
  const server = relay();
  const a = client(server, alice);
  const b = client(server, bob);
  await a.writes.ready;
  await a.catalog.refresh();
  const share = await a.catalog.publish(
    30175,
    "helper",
    true,
    agentBody("Helper"),
  );
  expect(a.catalog.state(30175, "helper").change).toMatchObject({
    operation: share,
    shared: true,
    delivery: "queued",
  });
  await settled(a.writes, share);
  expect(a.catalog.state(30175, "helper")).toMatchObject({
    shared: true,
    change: { shared: true, delivery: "accepted" },
  });
  // Accepted local heads are discoverable to their owner before the relay read.
  expect(a.catalog.snapshot().agents.map((entry) => entry.owner)).toEqual([
    alice.pubkey,
  ]);
  await b.catalog.refresh();
  expect(b.catalog.snapshot().agents[0]).toMatchObject({
    owner: alice.pubkey,
    d: "helper",
    agent: { displayName: "Helper", systemPrompt: "Be Helper." },
  });

  // Same-second unshare must still supersede the share under NIP-33.
  const unshare = await a.catalog.publish(30175, "helper", false);
  const removed = await settled(a.writes, unshare);
  const shared = a.writes.local
    .snapshot()
    .find((item) => item.event.id === share);
  expect(removed.event.created_at).toBeGreaterThan(
    shared?.event.created_at ?? Infinity,
  );
  expect(removed.event.content).toBe(agentBody("Helper"));
  expect(removed.event.tags.some(([name]) => name === "shared")).toBe(false);
  expect(a.catalog.state(30175, "helper")).toMatchObject({
    shared: false,
    change: { shared: false, delivery: "accepted" },
  });
  await b.catalog.refresh();
  expect(b.catalog.snapshot().agents).toEqual([]);
  await a.catalog.refresh();
  expect(a.catalog.snapshot().agents).toEqual([]);
});

it("reports a refusal, keeps it across a restart and retries it", async () => {
  const server = relay();
  const storage = memoryStorage();
  const first = client(server, alice, storage);
  await first.writes.ready;
  await first.catalog.refresh();
  server.refuse(true);
  const id = await first.catalog.publish(
    30178,
    "team-1",
    true,
    teamBody("Crew"),
  );
  await settled(first.writes, id);
  expect(first.catalog.state(30178, "team-1")).toMatchObject({
    shared: false,
    change: { operation: id, shared: true, delivery: "rejected" },
  });
  await flush();
  first.owner.dispose();

  const second = client(server, alice, storage);
  await second.writes.ready;
  expect(second.catalog.state(30178, "team-1").change).toMatchObject({
    operation: id,
    delivery: "rejected",
  });
  server.refuse(false);
  second.catalog.retry(id);
  await settled(second.writes, id);
  await second.catalog.refresh();
  expect(second.catalog.state(30178, "team-1")).toMatchObject({
    shared: true,
    change: { delivery: "accepted" },
  });
  expect(second.catalog.snapshot().teams.map((team) => team.name)).toEqual([
    "Crew",
  ]);
});

it("refuses to publish without a writer, a completed read or known content", async () => {
  const server = relay();
  const catalog = createCommunityCatalog({
    reader: server.reader(alice),
    viewer: alice.pubkey,
    outbox: undefined,
    local: undefined,
  });
  owners.push(catalog);
  await expect(catalog.queries.publish(30175, "x", true, "{}")).rejects.toThrow(
    "This community cannot update catalog sharing.",
  );
  const { catalog: writable } = client(server, alice);
  await expect(writable.publish(30175, "unknown", false)).rejects.toThrow(
    "The community catalog is still loading. Try again.",
  );
  await writable.refresh();
  await expect(writable.publish(30175, "unknown", false)).rejects.toThrow(
    "Nothing has been shared from this coordinate.",
  );
});

const now = () => Math.floor(Date.now() / 1000);
const bodies = { 30175: agentBody("Helper"), 30178: teamBody("Crew") };
const listed = (catalog: ReturnType<typeof client>["catalog"]) => [
  ...catalog.snapshot().agents,
  ...catalog.snapshot().teams,
];

describe.each([30175, 30178] as const)("kind %i unsharing", (kind) => {
  const body = bodies[kind];
  const head = (created_at: number) =>
    signed(alice, {
      kind,
      tags: [
        ["d", "x"],
        ["shared", "true"],
      ],
      content: body,
      created_at,
    });

  it("supersedes a newer head from another device on a fresh journal", async () => {
    const server = relay();
    const ahead = now() + 30;
    server.put(head(ahead));
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const id = await a.catalog.publish(kind, "x", false);
    const sent = await settled(a.writes, id);
    expect(sent.event.created_at).toBe(ahead + 1);
    expect(a.catalog.state(kind, "x")).toMatchObject({
      shared: false,
      change: { shared: false, delivery: "accepted" },
    });
    await b.catalog.refresh();
    expect(listed(b.catalog)).toEqual([]);
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x").shared).toBe(false);
  });

  it("breaks a same-second tie with the observed head", async () => {
    const server = relay();
    const at = now();
    server.put(head(at));
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const sent = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", false),
    );
    expect(sent.event.created_at).toBeGreaterThan(at);
    await b.catalog.refresh();
    expect(listed(b.catalog)).toEqual([]);
  });

  it("orders after a dismissed share, and dismissal never revives it", async () => {
    const server = relay();
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const share = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", true, body),
    );
    await a.catalog.dismiss(share.event.id);
    const unshare = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", false),
    );
    expect(unshare.event.created_at).toBeGreaterThan(share.event.created_at);
    await a.catalog.dismiss(unshare.event.id);
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
    await b.catalog.refresh();
    expect(listed(b.catalog)).toEqual([]);
  });

  it("a disconnect after dismissing an unshare never revives the share", async () => {
    const server = relay();
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    await settled(a.writes, await a.catalog.publish(kind, "x", true, body));
    const unshare = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", false),
    );
    await a.catalog.dismiss(unshare.event.id);
    a.link.down = true;
    a.owner.clear();
    expect(a.catalog.state(kind, "x").shared).toBe(false);
    expect(listed(a.catalog)).toEqual([]);
    await a.catalog.refresh().catch(() => {});
    expect(a.catalog.state(kind, "x").shared).toBe(false);
    expect(listed(a.catalog)).toEqual([]);
    a.link.down = false;
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x").shared).toBe(false);
    expect(listed(a.catalog)).toEqual([]);
  });

  it("a disconnect never revives a share another device unshared", async () => {
    const server = relay();
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    const share = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", true, body),
    );
    server.put(
      signed(alice, {
        kind,
        tags: [["d", "x"]],
        content: "",
        created_at: share.event.created_at + 5,
      }),
    );
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    a.link.down = true;
    a.owner.clear();
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
    await a.catalog.refresh().catch(() => {});
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
    a.link.down = false;
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
  });

  it("refuses rather than publishing an unshare the head would outrank", async () => {
    const server = relay();
    server.put(head(now() + 120));
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    await expect(a.catalog.publish(kind, "x", false)).rejects.toThrow(
      "Sharing is changing too quickly or your clock changed.",
    );
    expect(a.catalog.state(kind, "x")).toEqual({ shared: true });
  });

  it("an accepted unshare a newer competing head outranks is not reported as removed", async () => {
    const server = relay();
    server.put(head(now()));
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const release = server.hold();
    const id = await a.catalog.publish(kind, "x", false);
    // Another device lands a newer share after the pre-read; the relay keeps
    // it and still answers the unshare as accepted (NIP-01 `duplicate:`).
    server.put(head(now() + 60));
    release();
    const sent = await settled(a.writes, id);
    expect(sent.delivery).toBe("accepted");
    expect(a.catalog.state(kind, "x")).toEqual({ shared: true });
    await b.catalog.refresh();
    expect(listed(b.catalog)).toHaveLength(1);
  });

  it("outranks a head another device published after the catalog read", async () => {
    const server = relay();
    server.put(head(now()));
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    const later = now() + 30;
    server.put(head(later));
    const sent = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", false),
    );
    expect(sent.event.created_at).toBe(later + 1);
    expect(a.catalog.state(kind, "x")).toMatchObject({
      shared: false,
      change: { shared: false, delivery: "accepted" },
    });
  });

  it("an unshare preflight never joins a confirmation read that predates it", async () => {
    const server = relay();
    const a = coalescingClient(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    const release = server.hold();
    const share = await a.catalog.publish(kind, "x", true, body);
    // The share's confirmation read starts and stalls with the old head.
    const stale = a.holdNext();
    const issued = a.issued();
    release();
    for (let i = 0; i < 50 && a.issued() === issued; i++) await flush();
    expect(a.issued()).toBe(issued + 1);
    // Another device lands a newer share before this unshare's preflight.
    const later = now() + 30;
    server.put(head(later));
    const unshare = a.catalog.publish(kind, "x", false);
    await flush();
    stale();
    const sent = await settled(a.writes, await unshare);
    expect(sent.event.id).not.toBe(share);
    expect(sent.event.created_at).toBe(later + 1);
    expect(a.catalog.state(kind, "x")).toMatchObject({
      shared: false,
      change: { shared: false, delivery: "accepted" },
    });
  });

  it("a stale replica never promotes a change the writer outranked", async () => {
    const server = relay();
    server.put(head(now()));
    let stale: RelayEvent | undefined;
    const a = client(server, alice, memoryStorage(), (events) =>
      stale ? [stale] : events,
    );
    await a.writes.ready;
    await a.catalog.refresh();
    const release = server.hold();
    const id = await a.catalog.publish(kind, "x", false);
    for (let i = 0; i < 50 && !stale; i++) {
      await flush();
      stale = a.writes.local.snapshot().find((item) => item.event.id === id)
        ?.signed as RelayEvent | undefined;
    }
    expect(stale).toBeDefined();
    // The writer keeps a newer share; a lagging replica serves the unshare.
    server.put(head(now() + 40));
    release();
    expect((await settled(a.writes, id)).delivery).toBe("accepted");
    expect(a.catalog.state(kind, "x")).toEqual({ shared: true });
    await a.catalog.refresh();
    await flush();
    expect(a.catalog.state(kind, "x")).toEqual({ shared: true });
  });

  it("surfaces a failed confirmation read and re-reads on retry without resending", async () => {
    const server = relay();
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    const release = server.hold();
    const id = await a.catalog.publish(kind, "x", true, body);
    a.link.down = true;
    release();
    const sent = await settled(a.writes, id);
    expect(sent.delivery).toBe("accepted");
    expect(a.catalog.state(kind, "x").change).toMatchObject({
      operation: id,
      delivery: "queued",
      stalled: true,
      error:
        "The relay accepted the update, but the catalog could not confirm it.",
    });
    a.link.down = false;
    a.catalog.retry(id);
    await flush();
    await flush();
    expect(a.catalog.state(kind, "x")).toEqual({
      shared: true,
      change: { operation: id, shared: true, delivery: "accepted" },
    });
    const own = a.writes.local
      .snapshot()
      .filter((item) => item.event.kind === kind);
    expect(own.map((item) => item.event.id)).toEqual([id]);
  });

  it("a Retry during refresh reconciliation re-reads without resending", async () => {
    const server = relay();
    const a = coalescingClient(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    const release = server.hold();
    const id = await a.catalog.publish(kind, "x", true, body);
    a.failNext();
    release();
    await settled(a.writes, id);
    expect(a.catalog.state(kind, "x").change?.stalled).toBe(true);
    expect(a.publishes()).toBe(1);
    // A refresh starts a strong confirmation read that stays pending.
    const read = a.holdNext();
    const issued = a.issued();
    const refreshed = a.catalog.refresh();
    for (let i = 0; i < 50 && a.issued() === issued; i++) await flush();
    expect(a.issued()).toBe(issued + 1);
    expect(a.catalog.state(kind, "x").change?.stalled).toBeUndefined();
    // A Retry rendered before the refresh still only reconciles.
    a.catalog.retry(id);
    a.catalog.retry(id);
    await flush();
    expect(a.publishes()).toBe(1);
    read();
    await refreshed;
    for (let i = 0; i < 5; i++) await flush();
    expect(a.catalog.state(kind, "x")).toEqual({
      shared: true,
      change: { operation: id, shared: true, delivery: "accepted" },
    });
    a.catalog.retry(id);
    await flush();
    expect(a.publishes()).toBe(1);
  });

  it("shares and unshares maximum-size content through the outbox", async () => {
    // Every `"` escapes once in content and again in the serialized event.
    // Member prompts are capped, so a team spreads the padding over members.
    const quarter = (pad: string, index: number) =>
      pad.slice((index * pad.length) / 4, ((index + 1) * pad.length) / 4);
    const shape = (pad: string) =>
      kind === 30175
        ? JSON.stringify({ display_name: "Big", system_prompt: pad })
        : JSON.stringify({
            v: 1,
            name: "Big",
            members: [0, 1, 2, 3].map((index) => ({
              member_key: `k${index}`,
              display_name: "Mate",
              system_prompt: quarter(pad, index),
            })),
          });
    const padded = (size: number) => {
      const room = size - bytes(shape(""));
      const text = shape(
        '"'.repeat(Math.floor(room / 2)) + "a".repeat(room % 2),
      );
      expect(bytes(text)).toBe(size);
      return text;
    };
    const server = relay();
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const share = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", true, padded(MAX_CONTENT_BYTES)),
    );
    expect(byteSize(share.event)).toBeGreaterThan(2 * OUTBOX_INPUT_MAX_BYTES);
    expect(a.catalog.state(kind, "x")).toMatchObject({
      shared: true,
      change: { shared: true, delivery: "accepted" },
    });
    await b.catalog.refresh();
    expect(listed(b.catalog)).toHaveLength(1);
    const unshare = await settled(
      a.writes,
      await a.catalog.publish(kind, "x", false),
    );
    expect(bytes(unshare.event.content)).toBe(MAX_CONTENT_BYTES);
    expect(a.catalog.state(kind, "x")).toMatchObject({
      shared: false,
      change: { shared: false, delivery: "accepted" },
    });

    await expect(
      a.catalog.publish(kind, "y", true, padded(MAX_CONTENT_BYTES + 1)),
    ).rejects.toThrow("Message is empty or too large");
    expect(a.catalog.state(kind, "y")).toEqual({ shared: false });
  });
});

it("keeps the ordinary input bound for non-catalog kinds", async () => {
  const a = client(relay(), alice);
  await a.writes.ready;
  expect(() =>
    a.writes.outbox.send({
      kind: 9,
      content: "x".repeat(OUTBOX_INPUT_MAX_BYTES),
      tags: [["h", "channel"]],
    }),
  ).toThrow("Message is empty or too large");
});

it("reconciles a restored accepted share once the relay read returns it", async () => {
  const server = relay();
  const storage = memoryStorage();
  const first = client(server, alice, storage);
  await first.writes.ready;
  await first.catalog.refresh();
  const id = await first.catalog.publish(
    30175,
    "helper",
    true,
    agentBody("Helper"),
  );
  await settled(first.writes, id);
  await flush();
  first.owner.dispose();

  const second = client(server, alice, storage);
  await second.writes.ready;
  // A restored receipt is not proof of the head until a fresh read.
  expect(second.catalog.state(30175, "helper")).toMatchObject({
    shared: false,
    change: { operation: id, delivery: "queued" },
  });
  await second.catalog.refresh();
  expect(second.catalog.state(30175, "helper")).toMatchObject({
    shared: true,
    change: { operation: id, delivery: "accepted" },
  });
  expect(second.catalog.state(30175, "helper").change?.stalled).toBeUndefined();
});

it("re-reads a listed team and refuses a changed, unshared or missing head", async () => {
  const server = relay();
  const team = (created_at: number, shared = true, name = "Crew") =>
    signed(alice, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ...(shared ? [["shared", "true"]] : []),
      ] as string[][],
      content: teamBody(name),
      created_at,
    });
  server.put(team(10));
  const reader = client(server, bob);
  await reader.catalog.refresh();
  const [listed] = reader.catalog.snapshot().teams;
  if (!listed) throw new Error("team not listed");
  await expect(reader.catalog.currentTeam(listed)).resolves.toMatchObject({
    eventId: listed.eventId,
    name: "Crew",
  });

  server.put(team(11, true, "Crew v2"));
  await expect(reader.catalog.currentTeam(listed)).rejects.toThrow(
    "This team has changed since it was listed. Refresh and try again.",
  );

  // The owner can read its own unshared head; other readers find nothing.
  const owner = client(server, alice);
  await owner.catalog.refresh();
  const [own] = owner.catalog.snapshot().teams;
  if (!own) throw new Error("own team not listed");
  const unshared = team(12, false);
  server.put(unshared);
  await expect(
    owner.catalog.currentTeam({ ...own, eventId: unshared.id }),
  ).rejects.toThrow("This team is no longer shared to the community.");
  await expect(reader.catalog.currentTeam(listed)).rejects.toThrow(
    "This team is no longer available in the catalog.",
  );

  const missing = client(relay(), bob);
  await expect(missing.catalog.currentTeam(listed)).rejects.toThrow(
    "This team is no longer available in the catalog.",
  );
});
