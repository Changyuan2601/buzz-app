// @vitest-environment node
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { afterEach, expect, it, vi } from "vitest";
import { AgentFeed } from "./feed";

/** A relay connection the test answers by hand. */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 0;
  readonly sent: unknown[][] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as unknown[]);
  }
  close() {}
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  opened() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
  receive(message: unknown[]) {
    this.emit("message", { data: JSON.stringify(message) });
  }
  reqs() {
    return this.sent.filter((message) => message[0] === "REQ");
  }
}

/** The id of the login the feed sent. */
const loginId = (socket: FakeSocket) => {
  const login = socket.sent.find((message) => message[0] === "AUTH");
  if (!login) throw new Error("No login sent");
  return (login[1] as { id: string }).id;
};

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
  expect(socket.reqs().map((message) => message[1])).toEqual([
    "mentions",
    "rosters",
    "channels",
    "metadata",
  ]);
  socket.receive(["CLOSED", "channels", "error: too many"]);
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
  socket.receive(["EVENT", "metadata", metadata("dm", "dm")]);
  socket.receive(["EVENT", "metadata", metadata("group", "dm")]);
  socket.receive(["EVENT", "metadata", metadata("stream", "stream")]);
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
