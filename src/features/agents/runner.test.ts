// AgentRunners through a host other than AgentsService, as the standalone
// agent host (src/agent-host) gives it: the RunnerHost contract alone.
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { expect, it, vi } from "vitest";
import { AgentFeed } from "../../agent-host/feed";
import { FakeSocket } from "../../agent-host/test-socket";
import type { RelayEvent } from "../relay/events";
import { createLocalAgentActivity } from "./local-activity";
import { AgentRunners, type RunnerHost } from "./runner";
import type { Agent, Delivery, RegisteredAgentType } from "./service";
import type { AgentRecord } from "./store";

const pubkey = "a".repeat(64);
const owner = "b".repeat(64);
const someone = "c".repeat(64);
const agent: Agent = Object.freeze({
  pubkey,
  name: "Echo",
  type: "test/echo",
  owner,
  relay: "wss://relay.example.test",
  place: "here",
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: false,
  config: { reply: "hi" },
});
const mention = (id: string) =>
  ({
    id: id.padEnd(64, "0"),
    pubkey: someone,
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "channel"],
      ["p", pubkey],
    ],
    content: "hello",
    sig: "f".repeat(128),
  }) as unknown as RelayEvent;

function fixture(holds = true) {
  let live = true;
  const record: AgentRecord = { pubkey, attention: {}, config: agent.config };
  const custody = {
    claim: vi.fn(async () => holds),
    release: vi.fn(async () => {}),
    publish: vi.fn(async (_: string, event: { kind: number }) => ({
      ...mention("e"),
      pubkey,
      kind: event.kind,
    })),
    query: vi.fn(async () => []),
    upload: vi.fn(),
    media: vi.fn(),
    remember: vi.fn(),
  };
  const host: RunnerHost = {
    ready: (key) => (live && key === pubkey ? agent : undefined),
    agent: (key) => (key === pubkey ? agent : undefined),
    member: () => true,
    dm: () => false,
    community: () => undefined,
    records: () => [record],
    checkpoints: { read: () => ({}), write: () => {} },
    scope: () => "scope",
    saved: () => record,
    record: () => record,
    change: async (_, apply) => apply(record),
    changing: () => false,
    timers: () => ({}),
    progress: () => {},
    start: () => ({ ok: true, config: agent.config, revisions: [] }),
    team: () => "",
    templates: () => [],
    tabs: () => undefined,
    classifier: () => "unavailable",
    jev: () => undefined,
    jevStatus: () => undefined,
    classifierKey: () => "missing",
    classifierKeyGeneration: () => 0,
    setClassifierKey: () => {},
    context: async () => {
      throw new Error("No classifier");
    },
    displayName: () => null,
    custody: custody as unknown as RunnerHost["custody"],
    activity: createLocalAgentActivity(),
    soloChat: async () => false,
    remembered: () => {},
    finished: () => {},
    named: () => {},
  };
  const ran: Delivery[] = [];
  const type = {
    id: "echo",
    title: "Echo",
    key: "test/echo",
    pluginId: "test",
    revision: "one",
    defaults: () => ({ config: agent.config }),
    run: vi.fn(async (delivery: Delivery) => {
      ran.push(delivery);
      await delivery.agent.publish({ kind: 9, content: "hi", tags: [] });
    }),
  } as unknown as RegisteredAgentType;
  const runners = new AgentRunners(host);
  runners.reconcile([{ pubkey, type: type.key }], new Map([[type.key, type]]));
  return {
    runners,
    custody,
    ran,
    type,
    offline: () => {
      live = false;
    },
  };
}

it("runs a mention once it holds the agent, and publishes as the agent", async () => {
  const f = fixture();
  const event = mention("1");
  f.runners.dispatch({ events: [event], channelId: "channel" }, () => true, 0);
  // The same event again, as after a reconnect's catch-up, runs once.
  f.runners.dispatch({ events: [event], channelId: "channel" }, () => true, 0);
  await vi.waitFor(() => expect(f.ran).toHaveLength(1));
  expect(f.custody.claim).toHaveBeenCalledWith(pubkey);
  expect(f.ran[0]).toMatchObject({
    trigger: { type: "mention", event },
    channelId: "channel",
    config: agent.config,
    agent: { pubkey, owner },
  });
  await vi.waitFor(() =>
    expect(f.custody.publish).toHaveBeenCalledWith(
      pubkey,
      expect.objectContaining({ kind: 9, content: "hi" }),
    ),
  );
  expect(f.runners.runs(pubkey)).toBe(true);
});

it("leaves a mention to the copy that holds the agent", async () => {
  const f = fixture(false);
  f.runners.dispatch({ events: [mention("2")] }, () => true, 0);
  await vi.waitFor(() => expect(f.custody.claim).toHaveBeenCalled());
  await Promise.resolve();
  expect(f.type.run).not.toHaveBeenCalled();
  expect(f.runners.runs(pubkey)).toBe(false);
});

it("releases the agent once its community is no longer live", async () => {
  const f = fixture();
  f.runners.resume(new Set([pubkey]));
  await vi.waitFor(() => expect(f.custody.claim).toHaveBeenCalled());
  f.offline();
  f.runners.resume(new Set());
  await vi.waitFor(() =>
    expect(f.custody.release).toHaveBeenCalledWith(pubkey),
  );
});

it("runs every mention the standalone feed heard while not listening, past the agent's queue", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  try {
    const f = fixture();
    const secret = generateSecretKey();
    const feed = new AgentFeed({
      relay: "wss://relay.example.test",
      secret,
      pubkey: getPublicKey(secret),
      onEvents: (batch) => f.runners.dispatch(batch, () => true, 0),
      onStatus: () => {},
    });
    feed.start();
    const socket = FakeSocket.last as FakeSocket;
    socket.opened();
    // No login asked for: it subscribes as it is, and has heard the past.
    await vi.advanceTimersByTimeAsync(2_000);
    socket.receive(["EOSE", "mentions"]);
    socket.receive(["EOSE", "rosters"]);
    // One stream is lost; the mentions stream hears a burst meanwhile.
    socket.receive(["CLOSED", "rosters", "error: busy"]);
    // Signed, as the feed checks.
    const sender = generateSecretKey();
    const burst = Array.from(
      { length: 40 },
      (_, index) =>
        finalizeEvent(
          {
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["h", "channel"],
              ["p", pubkey],
            ],
            content: `hello ${index}`,
          },
          sender,
        ) as unknown as RelayEvent,
    );
    for (const event of burst) socket.receive(["EVENT", "mentions", event]);
    expect(f.ran).toHaveLength(0);
    // Listening again: the burst waits for room rather than overflow.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      f.runners.tick();
      expect(f.ran).toHaveLength(burst.length);
    });
    expect(
      new Set(
        f.ran.map(
          (delivery) => (delivery.trigger as { event: RelayEvent }).event.id,
        ),
      ),
    ).toEqual(new Set(burst.map((event) => event.id)));
    feed.stop();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
