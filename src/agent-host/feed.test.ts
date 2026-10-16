// @vitest-environment node
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { afterEach, expect, it, vi } from "vitest";
import { AgentFeed, CHANNEL_BATCH } from "./feed";
import { asked, FakeSocket, latest, loginId } from "./test-socket";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("opens again the subscriptions a relay closed until a late login, and is not listening meanwhile", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const secret = generateSecretKey();
  const statuses: boolean[] = [];
  const feed = new AgentFeed({
    relay: "wss://relay.example.test",
    secret,
    pubkey: getPublicKey(secret),
    onEvents: () => {},
    onStatus: (live) => statuses.push(live),
  });
  feed.start();
  const socket = FakeSocket.last as FakeSocket;
  socket.opened();
  // No login asked for in two seconds: it subscribes as it is.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(socket.reqs().map((message) => message[1])).toEqual([
    "mentions",
    "rosters",
  ]);
  expect(statuses.at(-1)).toBe(true);
  // Then the relay asks for a login, and closes both until it has one.
  socket.receive(["AUTH", "challenge"]);
  socket.receive(["CLOSED", "mentions", "auth-required: log in first"]);
  socket.receive(["CLOSED", "rosters", "auth-required: log in first"]);
  expect(statuses.at(-1)).toBe(false);
  socket.receive(["OK", loginId(socket), true, ""]);
  expect(socket.reqs().map((message) => message[1])).toEqual([
    "mentions",
    "rosters",
    "mentions",
    "rosters",
  ]);
  expect(statuses.at(-1)).toBe(true);
  feed.stop();
});

it("is not listening while the relay has closed its channel subscription", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const statuses: boolean[] = [];
  const feed = new AgentFeed({
    relay: "wss://relay.example.test",
    secret,
    pubkey,
    onEvents: () => {},
    onStatus: (live) => statuses.push(live),
  });
  feed.start();
  const socket = FakeSocket.last as FakeSocket;
  socket.opened();
  socket.receive(["AUTH", "challenge"]);
  socket.receive(["OK", loginId(socket), true, ""]);
  expect(statuses.at(-1)).toBe(true);
  // The relay's roster of a channel the agent is in.
  const roster = finalizeEvent(
    {
      kind: 39002,
      created_at: 100,
      tags: [
        ["d", "channel-1"],
        ["p", pubkey],
      ],
      content: "",
    },
    generateSecretKey(),
  );
  socket.receive(["EVENT", "rosters", roster]);
  expect(asked(socket)).toEqual([
    "mentions",
    "rosters",
    "channels:0",
    "metadata:0",
  ]);
  socket.receive(["CLOSED", latest(socket, "channels:0"), "error: too many"]);
  expect(statuses.at(-1)).toBe(false);
  feed.stop();
});

it("knows a channel is a DM of the agent and one other from its roster and type", () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const other = getPublicKey(generateSecretKey());
  const third = getPublicKey(generateSecretKey());
  const feed = new AgentFeed({
    relay: "wss://relay.example.test",
    secret,
    pubkey,
    onEvents: () => {},
    onStatus: () => {},
  });
  feed.start();
  const socket = FakeSocket.last as FakeSocket;
  socket.opened();
  socket.receive(["AUTH", "challenge"]);
  socket.receive(["OK", loginId(socket), true, ""]);
  const relay = generateSecretKey();
  const roster = (channel: string, at: number, members: string[]) =>
    finalizeEvent(
      {
        kind: 39002,
        created_at: at,
        tags: [["d", channel], ...members.map((member) => ["p", member])],
        content: "",
      },
      relay,
    );
  const metadata = (channel: string, type: string) =>
    finalizeEvent(
      {
        kind: 39000,
        created_at: 100,
        tags: [
          ["d", channel],
          ["t", type],
          ["t", "label"],
        ],
        content: "",
      },
      relay,
    );
  socket.receive(["EVENT", "rosters", roster("dm", 100, [pubkey, other])]);
  socket.receive(["EVENT", "rosters", roster("group", 100, [pubkey, other])]);
  socket.receive(["EVENT", "rosters", roster("stream", 100, [pubkey, other])]);
  // Its type is unknown until the channel's metadata arrives.
  expect(feed.dm("dm")).toBe(false);
  socket.receive(["EVENT", latest(socket, "metadata:0"), metadata("dm", "dm")]);
  socket.receive([
    "EVENT",
    latest(socket, "metadata:0"),
    metadata("group", "dm"),
  ]);
  socket.receive([
    "EVENT",
    latest(socket, "metadata:0"),
    metadata("stream", "stream"),
  ]);
  expect(feed.dm("dm")).toBe(true);
  expect(feed.dm("stream")).toBe(false);
  // A newer roster with a third member makes it a group DM; an older one is ignored.
  socket.receive([
    "EVENT",
    "rosters",
    roster("group", 200, [pubkey, other, third]),
  ]);
  socket.receive(["EVENT", "rosters", roster("group", 150, [pubkey, other])]);
  expect(feed.dm("group")).toBe(false);
  feed.stop();
});

/** A feed logged in on a fake relay, and how to sign as the relay. */
function loggedIn() {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const statuses: boolean[] = [];
  const heard: string[] = [];
  const feed = new AgentFeed({
    relay: "wss://relay.example.test",
    secret,
    pubkey,
    onEvents: (batch) => {
      for (const event of batch.events)
        heard.push(`${event.content}:${feed.dm(batch.channelId ?? "")}`);
    },
    onStatus: (live) => statuses.push(live),
  });
  feed.start();
  const socket = FakeSocket.last as FakeSocket;
  socket.opened();
  socket.receive(["AUTH", "challenge"]);
  socket.receive(["OK", loginId(socket), true, ""]);
  const relay = generateSecretKey();
  const sign = (kind: number, tags: string[][], content = "", at = 100) =>
    finalizeEvent({ kind, created_at: at, tags, content }, relay);
  const roster = (channel: string, members: string[]) =>
    sign(39002, [["d", channel], ...members.map((member) => ["p", member])]);
  return { feed, socket, pubkey, statuses, heard, sign, roster };
}

it("holds a new channel's messages until its metadata says whether it is a DM", () => {
  const { feed, socket, pubkey, heard, sign, roster } = loggedIn();
  const owner = getPublicKey(generateSecretKey());
  socket.receive(["EVENT", "rosters", roster("dm", [pubkey, owner])]);
  // The owner's untagged message arrives before the channel's metadata.
  const message = sign(9, [["h", "dm"]], "hello", 150);
  socket.receive(["EVENT", latest(socket, "channels:0"), message]);
  // Heard again after a reconnect's overlap: held once.
  socket.receive(["EVENT", latest(socket, "channels:0"), message]);
  expect(heard).toEqual([]);
  socket.receive([
    "EVENT",
    latest(socket, "metadata:0"),
    sign(39000, [
      ["d", "dm"],
      ["t", "dm"],
    ]),
  ]);
  expect(heard).toEqual([]);
  socket.receive(["EOSE", latest(socket, "metadata:0")]);
  // Given on once the DM is known as one.
  expect(heard).toEqual(["hello:true"]);
  // Later messages in it go straight on.
  socket.receive([
    "EVENT",
    latest(socket, "channels:0"),
    sign(9, [["h", "dm"]], "again", 160),
  ]);
  expect(heard).toEqual(["hello:true", "again:true"]);
  feed.stop();
});

it("gives a channel's held messages on, not as a DM, when the relay refuses its metadata", () => {
  const { feed, socket, pubkey, heard, sign, roster } = loggedIn();
  socket.receive(["EVENT", "rosters", roster("room", [pubkey])]);
  socket.receive([
    "EVENT",
    latest(socket, "channels:0"),
    sign(9, [["h", "room"]], "hi", 150),
  ]);
  socket.receive([
    "CLOSED",
    latest(socket, "metadata:0"),
    "restricted: not allowed",
  ]);
  expect(heard).toEqual(["hi:false"]);
  feed.stop();
});

it("asks again for a subscription the relay closed after the login, and is listening once it is open", async () => {
  const { feed, socket, statuses } = loggedIn();
  expect(statuses.at(-1)).toBe(true);
  socket.receive(["CLOSED", "mentions", "error: database error"]);
  socket.receive(["CLOSED", "rosters", "error: database error"]);
  expect(statuses.at(-1)).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect(asked(socket)).toEqual(["mentions", "rosters"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(asked(socket)).toEqual(["mentions", "rosters", "mentions", "rosters"]);
  expect(statuses.at(-1)).toBe(true);
  // Closed again before it sent anything: the wait grows.
  socket.receive(["CLOSED", "mentions", "error: database error"]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(asked(socket)).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(asked(socket)).toHaveLength(5);
  expect(statuses.at(-1)).toBe(true);
  feed.stop();
});

it("does not ask again for a subscription the relay refuses", async () => {
  const { feed, socket, statuses } = loggedIn();
  socket.receive(["CLOSED", "mentions", "restricted: not a member"]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(asked(socket)).toEqual(["mentions", "rosters"]);
  expect(statuses.at(-1)).toBe(false);
  feed.stop();
});

it("hears channels in batches the relay accepts, asking again only for the batch that changed", () => {
  const { feed, socket, pubkey, statuses, roster } = loggedIn();
  for (let index = 0; index < CHANNEL_BATCH; index++)
    socket.receive(["EVENT", "rosters", roster(`c${index}`, [pubkey])]);
  const filters = (key: string) =>
    socket
      .reqs()
      .filter((message) => String(message[1]).startsWith(`${key}:`))
      .map((message) => message[2] as Record<string, string[]>);
  expect(filters("channels:0").at(-1)?.["#h"]).toHaveLength(CHANNEL_BATCH);
  const before = socket.reqs().length;
  socket.receive(["EVENT", "rosters", roster("last", [pubkey])]);
  // One more channel starts a second batch; the first is not asked again.
  expect(asked(socket).slice(before)).toEqual(["channels:1", "metadata:1"]);
  expect(filters("channels:1").at(-1)?.["#h"]).toEqual(["last"]);
  expect(filters("metadata:1").at(-1)?.["#d"]).toEqual(["last"]);
  for (const message of socket.reqs()) {
    const filter = message[2] as Record<string, string[] | undefined>;
    expect((filter["#h"] ?? filter["#d"] ?? []).length).toBeLessThanOrEqual(
      CHANNEL_BATCH,
    );
  }
  expect(statuses.at(-1)).toBe(true);
  // A batch the relay closes leaves the feed not listening until it is back.
  socket.receive(["CLOSED", latest(socket, "channels:1"), "error: busy"]);
  expect(statuses.at(-1)).toBe(false);
  feed.stop();
});

it("gives on what open subscriptions heard while another was asked for again, once listening", async () => {
  const { feed, socket, pubkey, statuses, heard, sign, roster } = loggedIn();
  socket.receive(["EVENT", "rosters", roster("room", [pubkey])]);
  socket.receive(["EOSE", latest(socket, "metadata:0")]);
  expect(statuses.at(-1)).toBe(true);
  socket.receive(["CLOSED", "rosters", "error: busy"]);
  expect(statuses.at(-1)).toBe(false);
  // The channel's subscription is still open, but the host takes nothing
  // while the feed is not listening.
  socket.receive([
    "EVENT",
    latest(socket, "channels:0"),
    sign(9, [["h", "room"]], "meanwhile", 150),
  ]);
  expect(heard).toEqual([]);
  const at = statuses.length;
  await vi.advanceTimersByTimeAsync(1_000);
  // Listening again, then given on.
  expect(statuses.slice(at)).toEqual([true]);
  expect(heard).toEqual(["meanwhile:false"]);
  feed.stop();
});

it("asks a stream it lost for what it missed, though other streams heard on", async () => {
  const { feed, socket, pubkey, sign, roster } = loggedIn();
  const start = Math.floor(Date.now() / 1000);
  for (let index = 0; index <= CHANNEL_BATCH; index++)
    socket.receive(["EVENT", "rosters", roster(`c${index}`, [pubkey])]);
  const since = (key: string) =>
    (
      socket
        .reqs()
        .find((message) => message[1] === latest(socket, key))?.[2] as
        | { since?: number }
        | undefined
    )?.since;
  socket.receive(["CLOSED", latest(socket, "channels:0"), "error: busy"]);
  // The second batch hears on, well past the overlap.
  socket.receive([
    "EVENT",
    latest(socket, "channels:1"),
    sign(9, [["h", `c${CHANNEL_BATCH}`]], "later", start + 300),
  ]);
  await vi.advanceTimersByTimeAsync(1_000);
  // The first batch asks again from where it stopped.
  expect(since("channels:0")).toBe(start - 30);
  // Once it has sent what it missed, it hears on as the others do.
  socket.receive(["EOSE", latest(socket, "channels:0")]);
  socket.receive(["CLOSED", latest(socket, "channels:0"), "error: busy"]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(since("channels:0")).toBe(start + 270);
  feed.stop();
});
