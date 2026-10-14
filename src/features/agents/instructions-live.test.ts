import { afterEach, expect, it, vi } from "vitest";
import { subscribeRelayTraffic } from "../relay/live";
import { createRelaySession } from "../relay/session";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { keypair, scriptedTransport, signed } from "../relay/testing";
import {
  InstructionStore,
  InstructionSync,
  resolveInstructions,
} from "./instructions";
import { INSTRUCTIONS_KIND } from "./instructions-envelope";

/** A relay socket the test answers frame by frame. */
class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(frame: unknown[]) {
    await this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The REQ ids of the instructions route, oldest first. */
  instructions() {
    return this.sent
      .filter(
        ([type, , filter]) =>
          type === "REQ" &&
          (filter as { kinds?: number[] }).kinds?.includes(INSTRUCTIONS_KIND),
      )
      .map(([, id]) => id as string);
  }
}

const COMMUNITY = "wss://relay.test";
const AGENT = "c".repeat(64);
const settle = () => vi.advanceTimersByTimeAsync(0);
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers();
  const viewer = keypair(),
    relay = keypair();
  const sockets: Socket[] = [];
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    scope: COMMUNITY,
    subscribe(callbacks) {
      const traffic = subscribeRelayTraffic(
        COMMUNITY,
        async (event) => signed(viewer, event),
        viewer.pubkey,
        callbacks,
        () => {
          const socket = new Socket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      );
      traffic.watchInstructions?.();
      return traffic;
    },
  });
  owners.push(owner);
  const version = (text: string, created_at: number) =>
    signed(viewer, {
      kind: INSTRUCTIONS_KIND,
      created_at,
      content: `c:${text}`,
      tags: [["p", AGENT]],
    });
  const stored: RelayEvent[] = [];
  const reads: ReadFilter[][] = [];
  let hold: Promise<void> | undefined;
  const store = new InstructionStore(
    (() => {
      const data = new Map<string, string>();
      return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
      };
    })(),
  );
  const controller = new AbortController();
  const sync = new InstructionSync({
    owner: viewer.pubkey,
    community: COMMUNITY,
    signal: controller.signal,
    store,
    codec: {
      prepare: async (_subject, text) => `c:${text}`,
      decode: async (_subject, events) =>
        events.map((event) => ({ id: event.id, text: event.content.slice(2) })),
    },
    async read(filters) {
      reads.push([...filters]);
      const held = hold;
      if (held) await held;
      // One page: a cursor read finds nothing older.
      return filters.some((filter) => filter.until !== undefined)
        ? []
        : stored.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          );
    },
    outbox: undefined,
    live: owner.session.live,
    subscribeLive: (listener) => owner.session.subscribeLive(listener),
    admitDeletions: (holds) => owner.session.admitInstructionsDeletions(holds),
    now: () => 1_800_000_000,
  });
  const socket = () => sockets.at(-1) as Socket;
  const connect = async () => {
    await settle();
    await socket().receive(["AUTH", "challenge"]);
    const auth = socket().sent.find(([type]) => type === "AUTH")?.[1] as {
      id: string;
    };
    await socket().receive(["OK", auth.id, true]);
    await settle();
  };
  const route = () =>
    owner.session.live
      .snapshot()
      .routes.find((item) => item.id === "instructions");
  const resolve = () =>
    resolveInstructions(
      store,
      viewer.pubkey,
      COMMUNITY,
      AGENT,
      { linked: false },
      sync.pendingDeletion(AGENT),
    );
  /** Authoritative scans begun: the first page of the owner's whole history. */
  const scans = () =>
    reads.filter(
      ([filter]) =>
        filter?.kinds?.includes(INSTRUCTIONS_KIND) &&
        !filter["#p"] &&
        !filter.ids &&
        filter.until === undefined,
    ).length;
  return {
    owner,
    sync,
    stored,
    socket,
    sockets,
    connect,
    route,
    resolve,
    version,
    scans,
    hold(value: Promise<void> | undefined) {
      hold = value;
    },
  };
}
const known = {
  state: "ready" as const,
  known: new Set([AGENT]),
  deleted: new Set<string>(),
};

it("T22 the first scan starts on the route's first EOSE, and a remote save held across it is the head", async () => {
  const h = await setup();
  h.sync.start();
  h.sync.identities(known);
  h.stored.push(h.version("backfill", 10));
  await h.connect();
  const [req] = h.socket().instructions();
  expect(req).toBeDefined();
  expect(h.route()?.status).toBe("pending");
  expect(h.scans()).toBe(0);
  let release = () => {};
  h.hold(new Promise<void>((r) => (release = r)));
  await h.socket().receive(["EOSE", req]);
  await settle();
  expect(h.route()?.status).toBe("live");
  expect(h.scans()).toBe(1);
  const remote = h.version("remote", 20);
  await h.socket().receive(["EVENT", req, remote]);
  await settle();
  h.hold(undefined);
  release();
  await settle();
  expect(h.resolve()).toMatchObject({ text: "remote", versionId: remote.id });
});

it("T22 a reconnect invalidates the old scan and scans again on the new EOSE", async () => {
  const h = await setup();
  h.sync.start();
  h.sync.identities(known);
  await h.connect();
  let release = () => {};
  h.hold(new Promise<void>((r) => (release = r)));
  await h.socket().receive(["EOSE", h.socket().instructions()[0]]);
  await settle();
  expect(h.scans()).toBe(1);
  // The old scan would install this; it must be discarded.
  h.stored.push(h.version("stale scan", 10));
  h.socket().close();
  while (h.sockets.length < 2) await vi.advanceTimersByTimeAsync(250);
  h.hold(undefined);
  release();
  await settle();
  expect(h.resolve()).toEqual({ blocked: "Instructions haven't synced yet" });
  h.stored.splice(0, h.stored.length, h.version("current", 11));
  await h.connect();
  // The old socket's EOSE for its old wire never shows `live`.
  const old = h.sockets[0] as Socket;
  await old.receive(["EOSE", old.instructions()[0]]);
  await settle();
  expect(h.route()?.status).toBe("pending");
  expect(h.scans()).toBe(1);
  await h.socket().receive(["EOSE", h.socket().instructions()[0]]);
  await settle();
  expect(h.scans()).toBe(2);
  expect(h.resolve()).toMatchObject({ text: "current" });
});

it("T22 CLOSED leaves the route in error with no scan and no absent head", async () => {
  const h = await setup();
  h.sync.start();
  h.sync.identities(known);
  await h.connect();
  await h
    .socket()
    .receive(["CLOSED", h.socket().instructions()[0], "restricted: nope"]);
  await settle();
  expect(h.route()?.status).toBe("error");
  expect(h.scans()).toBe(0);
  expect("blocked" in h.resolve()).toBe(true);
});

it("T22 a listener that registers after EOSE sees live and scans once", async () => {
  const h = await setup();
  await h.connect();
  await h.socket().receive(["EOSE", h.socket().instructions()[0]]);
  await settle();
  expect(h.route()?.status).toBe("live");
  h.stored.push(h.version("late", 10));
  h.sync.start();
  h.sync.identities(known);
  await settle();
  expect(h.scans()).toBe(1);
  expect(h.resolve()).toMatchObject({ text: "late" });
});

it("T22 a retry on the same socket ignores the retired wire's EOSE and scans on the new one", async () => {
  const h = await setup();
  h.sync.start();
  h.sync.identities(known);
  await h.connect();
  const [first] = h.socket().instructions();
  let release = () => {};
  h.hold(new Promise<void>((r) => (release = r)));
  await h.socket().receive(["EOSE", first]);
  await settle();
  expect(h.route()?.status).toBe("live");
  expect(h.scans()).toBe(1);
  // The held scan would install this; leaving `live` must discard it.
  h.stored.push(h.version("stale scan", 10));
  await h
    .socket()
    .receive(["CLOSED", first, "rate-limited: quota exceeded; retry in 1s"]);
  await settle();
  expect(h.route()?.status).not.toBe("live");
  h.hold(undefined);
  release();
  await settle();
  expect(h.resolve()).toEqual({ blocked: "Instructions haven't synced yet" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(h.sockets).toHaveLength(1);
  const [, second] = h.socket().instructions();
  expect(second).toBeDefined();
  expect(second).not.toBe(first);
  h.stored.splice(0, h.stored.length, h.version("current", 11));
  await h.socket().receive(["EOSE", first]);
  await settle();
  expect(h.route()?.status).toBe("pending");
  expect(h.scans()).toBe(1);
  await h.socket().receive(["EOSE", second]);
  await settle();
  expect(h.route()?.status).toBe("live");
  expect(h.scans()).toBe(2);
  expect(h.resolve()).toMatchObject({ text: "current" });
});
