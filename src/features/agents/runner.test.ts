// AgentRunners through a host other than AgentsService, as the standalone
// agent host (src/agent-host) gives it: the RunnerHost contract alone.
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { expect, it, vi } from "vitest";
import { listen } from "../../agent-host/listen";
import { LiveSocket } from "../../agent-host/test-socket";
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
    interrupted: { read: () => ({}), write: () => {}, changed: () => {} },
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
    decisions: () => undefined,
    keyStatus: () => undefined,
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

it("runs every mention the standalone host's live client hears, through the runner's backlog", async () => {
  const f = fixture();
  const secret = generateSecretKey();
  const viewer = getPublicKey(secret);
  const sockets: LiveSocket[] = [];
  const read = vi.fn();
  const listener = listen({
    relay: "wss://relay.example.test",
    secret,
    pubkey: viewer,
    query: async () => [
      finalizeEvent(
        {
          kind: 39002,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", "channel"],
            ["p", viewer],
          ],
          content: "",
        },
        generateSecretKey(),
      ) as unknown as RelayEvent,
    ],
    onEvents: (batch) => f.runners.dispatch(batch, () => true, 0),
    onStatus: () => {},
    onChannels: read,
    log: () => {},
    socket: () => {
      const socket = new LiveSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const socket = sockets.at(-1) as LiveSocket;
    await socket.auth();
    const [wire] = socket.channelWires();
    // Signed, as the client checks.
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
    // What the subscription sends before it is live: a replay.
    for (const event of burst) await socket.receive(["EVENT", wire, event]);
    await socket.receive(["EOSE", wire]);
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
  } finally {
    listener.stop();
  }
});
