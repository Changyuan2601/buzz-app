// @vitest-environment node
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";
import { afterEach, expect, it, vi } from "vitest";
import type { Filter } from "../buzz-mcp/client";
import type { RelayEvent } from "../features/relay/events";
import type { LiveBatch } from "../features/relay/incoming";
import { listen, readChannels } from "./listen";
import { LiveSocket } from "./test-socket";

afterEach(() => vi.useRealTimers());

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const owner = getPublicKey(generateSecretKey());
const someone = generateSecretKey();
const auth = ["auth", owner, "", "f".repeat(128)];

const sign = (
  kind: number,
  tags: string[][],
  key = someone,
  at = Math.floor(Date.now() / 1000),
) =>
  finalizeEvent(
    { kind, created_at: at, tags, content: "" },
    key,
  ) as unknown as RelayEvent;
const roster = (channel: string, members: readonly string[]) =>
  sign(39002, [["d", channel], ...members.map((member) => ["p", member])]);
const metadata = (channel: string, type: string) =>
  sign(39000, [
    ["d", channel],
    ["t", type],
  ]);

/** A relay whose reads answer from `events` as the relay filters them. */
function relay(events: () => readonly RelayEvent[]) {
  const reads: Filter[][] = [];
  const query = vi.fn(async (filters: readonly Filter[]) => {
    reads.push([...filters]);
    return events().filter((event) =>
      filters.some((filter) => {
        const f = filter as Record<string, unknown>;
        const has = (name: string) => {
          const want = f[`#${name}`] as string[] | undefined;
          return (
            !want ||
            event.tags.some(
              ([key, value]) => key === name && !!value && want.includes(value),
            )
          );
        };
        return (
          (f.kinds as number[]).includes(event.kind) &&
          has("p") &&
          has("d") &&
          // A system channel's roster comes only to a read that asks for it.
          (f["#t"]
            ? has("t")
            : event.kind !== 39002 ||
              !event.tags.some((tag) => tag[1] === "system"))
        );
      }),
    );
  });
  return { query, reads };
}

function host(events: () => readonly RelayEvent[]) {
  const sockets: LiveSocket[] = [];
  const batches: LiveBatch[] = [];
  const statuses: boolean[] = [];
  const channels = vi.fn();
  const { query, reads } = relay(events);
  const listener = listen({
    relay: "wss://relay.example.test",
    secret,
    pubkey,
    auth,
    query,
    onEvents: (batch) => batches.push(batch),
    onStatus: (live) => statuses.push(live),
    onChannels: channels,
    log: () => {},
    socket: () => {
      const socket = new LiveSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const socket = () => sockets.at(-1) as LiveSocket;
  return { listener, socket, batches, statuses, channels, query, reads };
}

it("logs in as the agent with its owner's attestation, and hears the channels its rosters list", async () => {
  const events = [
    roster("general", [owner, pubkey]),
    metadata("general", "stream"),
    roster("chat", [owner, pubkey]),
    metadata("chat", "dm"),
    roster("elsewhere", [owner]),
  ];
  const h = host(() => events);
  // Until its channels are read, membership is unknown, so a watch waits.
  expect(h.listener.member("general")).toBeUndefined();
  await vi.waitFor(() => expect(h.channels).toHaveBeenCalledOnce());
  expect(h.listener.member("general")).toBe(true);
  expect(h.listener.member("elsewhere")).toBe(false);
  expect(h.listener.dm("chat")).toBe(true);
  expect(h.listener.dm("general")).toBe(false);

  const login = await h.socket().auth();
  expect(login.pubkey).toBe(pubkey);
  expect(verifyEvent(login as never)).toBe(true);
  expect(login.tags).toContainEqual(auth);
  expect(h.statuses).toEqual([true]);
  expect(h.socket().channels()).toEqual(["chat", "general"]);
  h.listener.stop();
});

it("gives on the client's live events, and its replays marked as such", async () => {
  const events = [roster("general", [owner, pubkey])];
  const h = host(() => events);
  await vi.waitFor(() => expect(h.channels).toHaveBeenCalled());
  await h.socket().auth();
  const [wire] = h.socket().channelWires();
  const older = sign(9, [
    ["h", "general"],
    ["p", pubkey],
  ]);
  const newer = sign(9, [
    ["h", "general"],
    ["p", pubkey],
  ]);
  await h.socket().receive(["EVENT", wire, older]);
  await h.socket().receive(["EOSE", wire]);
  await h.socket().receive(["EVENT", wire, newer]);
  expect(
    h.batches.map(({ events, ...batch }) => ({
      ...batch,
      ids: events.map((event) => event.id),
    })),
  ).toEqual([
    { channelId: "general", replay: true, ids: [older.id] },
    { channelId: "general", ids: [newer.id] },
  ]);
  h.listener.stop();
});

it("reads its channels again when the relay says its membership changed, and hears the new one", async () => {
  const events = [roster("general", [owner, pubkey])];
  const h = host(() => events);
  await vi.waitFor(() => expect(h.channels).toHaveBeenCalledOnce());
  await h.socket().auth();
  expect(h.socket().channels()).toEqual(["general"]);
  events.push(roster("new", [owner, pubkey]), metadata("new", "dm"));
  const notice = sign(44100, [
    ["p", pubkey],
    ["h", "new"],
  ]);
  const membership = h.socket().wire("membership");
  await h.socket().receive(["EOSE", membership]);
  await h.socket().receive(["EVENT", membership, notice]);
  await vi.waitFor(() => expect(h.channels).toHaveBeenCalledTimes(2));
  expect(h.listener.member("new")).toBe(true);
  expect(h.listener.dm("new")).toBe(true);
  expect(h.socket().channels()).toContain("new");
  h.listener.stop();
});

it("stops hearing a channel the relay denies, until a read lists it again", async () => {
  const events = [
    roster("general", [owner, pubkey]),
    roster("gone", [owner, pubkey]),
  ];
  const h = host(() => events);
  await vi.waitFor(() => expect(h.channels).toHaveBeenCalledOnce());
  await h.socket().auth();
  events.splice(1, 1);
  const [wire] = h.socket().channelWires();
  await h
    .socket()
    .receive(["CLOSED", wire, "restricted: not a channel member"]);
  // The relay refused the batch both were heard in.
  expect(h.listener.member("gone")).toBe(false);
  expect(h.listener.member("general")).toBe(false);
  await vi.waitFor(() => expect(h.listener.member("general")).toBe(true));
  expect(h.listener.member("gone")).toBe(false);
  expect(h.listener.member("general")).toBe(true);
  expect(h.socket().channels()).toEqual(["general"]);
  h.listener.stop();
});

it("keeps the last channels it read when a read fails, and the app's recovery reads again", async () => {
  vi.useFakeTimers();
  let fail = false;
  const events = [roster("general", [owner, pubkey])];
  const h = host(() => {
    if (fail) throw new Error("busy");
    return events;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.channels).toHaveBeenCalledOnce();
  await h.socket().auth();
  await h.socket().established();
  fail = true;
  // The client's periodic repair asks for a read, which fails.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.listener.member("general")).toBe(true);
  const reads = h.query.mock.calls.length;
  fail = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.query.mock.calls.length).toBeGreaterThan(reads);
  expect(h.channels).toHaveBeenCalledTimes(2);
  h.listener.stop();
});

it("reads system channels through their opt-in filter, and only rosters that list the agent", async () => {
  const events = [
    roster("general", [owner, pubkey]),
    sign(39002, [
      ["d", "notices"],
      ["t", "system"],
      ["p", pubkey],
    ]),
    sign(39000, [
      ["d", "notices"],
      ["t", "system"],
    ]),
  ];
  const { query } = relay(() => events);
  const channels = await readChannels(query, pubkey);
  expect([...channels.keys()].sort()).toEqual(["general", "notices"]);
  expect(channels.get("notices")?.type).toBe("system");
});
