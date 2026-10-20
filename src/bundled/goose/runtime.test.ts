import { describe, expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import { callTool } from "../../buzz-mcp/tools";
import { createAgentMemories } from "../../features/agents/memory";
import { TOP_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import type { Agent, Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { fakeSpawn, flush } from "./goose-testing";
import {
  DEFAULT_CONFIG,
  GooseRuntime,
  sessionTitle,
  standalonePrompt,
} from "./runtime";

describe("sessionTitle", () => {
  it("names the agent, the channel and a thread's root", () => {
    expect(sessionTitle("Ada", "#general", "0123456789abcdef")).toBe(
      "Ada · #general · 01234567",
    );
    expect(sessionTitle(undefined, "DM")).toBe("Buzz agent · DM");
  });

  it("keeps the root when a long name is cut", () => {
    const title = sessionTitle("A".repeat(100), "#general", "0123456789");
    expect(title).toHaveLength(80);
    expect(title.endsWith(" · 01234567")).toBe(true);
  });
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const channel = "chan-1";
const message = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
    ...extra,
  }) as RelayEvent;

/** A runtime for one agent of Alice's in `channel`, with fake goose. */
function setup(
  options: Readonly<{
    /** Channels that are the owner's own Solo chats; the owner is the viewer. */
    solo?: Set<string>;
    hold?: boolean;
    reply?: string;
    thread?: readonly EventData[];
    scope?: "thread" | "channel";
    /** The agent's `core` memory as the host keeps it. */
    core?: string | null;
    /** The channel's Canvas. */
    canvas?: string;
  }> = {},
) {
  const fake = fakeSpawn({
    hold: options.hold ?? false,
    ...(options.reply ? { reply: options.reply } : {}),
  });
  const host = {
    spawn: fake.spawn,
    serveMcp: fake.serve,
    request: vi.fn(),
  } as unknown as Host;
  const read = vi.fn(async () => options.thread ?? []);
  const memories = {
    snapshot: () => ({ status: "ready", listing: { entries: [] } }),
    subscribe: () => () => {},
    refresh: async () => {},
    dispose: () => {},
  };
  const session = {
    read,
    agentMemories: { open: vi.fn(() => memories) },
    channels: {
      list: () => ({
        channels: [
          {
            id: channel,
            name: "general",
            channelType: options.solo?.has(channel) ? "solo" : "stream",
            members: [],
          },
        ],
      }),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => new Map(),
    },
    canvas: {
      available: options.canvas !== undefined,
      read: vi.fn(async () =>
        options.canvas === undefined
          ? null
          : {
              pubkey: alice,
              kind: 40100,
              created_at: 1,
              tags: [],
              content: options.canvas,
            },
      ),
    },
  };
  const relay = {
    snapshot: () => ({ status: "ready", session, viewer: alice }),
  } as unknown as RelayData;
  const core = vi.fn(async () => options.core);
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const runtime = new GooseRuntime(host, () => relay, core, storage);
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    pubkey: self,
    name: "Gander",
    owner: alice,
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return {
        ...message(String(published.length), template.content),
        ...template,
      };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
  };
  const deliver = (event: RelayEvent, extra: Partial<Delivery> = {}) =>
    runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config: { ...DEFAULT_CONFIG, scope: options.scope ?? "thread" },
      signal: new AbortController().signal,
      workingUntil: () => undefined,
      ...extra,
    } as unknown as Delivery);
  const goose = () => fake.geese.find((process) => process.turns.length);
  const runOnce = (key: string, prompt: string) =>
    runtime.runOnce({
      delivery: {
        agent,
        channelId: channel,
        config: DEFAULT_CONFIG,
      },
      key,
      signal: new AbortController().signal,
      prompt: async () => prompt,
    } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
  return {
    agent,
    core,
    deliver,
    runOnce,
    fake,
    goose,
    published,
    read,
    runtime,
    memoryOpen: session.agentMemories.open,
  };
}

describe("GooseRuntime", () => {
  it("continues an owner's Solo chat as one channel session posted at the top level", async () => {
    const earlier = message("1", "Earlier in the chat", {
      tags: [["h", channel]],
    });
    const first = message("2", "@Gander first");
    // A reply in an old thread of the chat is still the one conversation.
    const later = message("3", "@Gander more", {
      tags: [
        ["h", channel],
        ["e", earlier.id, "", "reply"],
        ["p", self],
      ],
    });
    const { agent, deliver, goose, published, read } = setup({
      solo: new Set([channel]),
      hold: true,
      thread: [earlier],
    });
    agent.query.mockImplementation(async () => [first]);
    await deliver(first);
    await flush(100);
    const process = goose();
    const turn = process?.turns[0];
    expect(turn?.text).toContain("Scope: channel");
    expect(turn?.text).toContain(`IMPORTANT: ${TOP_LEVEL_PROMPT}`);
    expect(turn?.text).toContain("Earlier in the chat");
    // A new session is shown the chat itself, not a thread.
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [9, 40002], "#h": [channel], limit: 13 }],
      expect.anything(),
    );
    const sessionId = turn?.sessionId ?? "";
    const reply = await process?.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { audience: "everyone", text: "x", reply: first.id },
    });
    expect(reply?.result).toEqual({
      content: [
        {
          type: "text",
          text: "This chat stays at the top level: send again without reply.",
        },
      ],
      isError: true,
    });
    await deliver(later);
    await flush(100);
    expect(process?.turns).toHaveLength(1);
    expect(turn?.steered).toHaveLength(1);
    process?.exit(1, "Error: Invalid API key\n");
    await flush(100);
    // The turn both mentions joined reports its failure once, at the chat's
    // top level.
    expect(published.map((event) => event.tags)).toEqual([
      [
        ["h", channel],
        ["p", alice],
      ],
    ]);
  });

  it("hands the host a stopper that cancels the mention's running turn", async () => {
    const { deliver, goose } = setup({ hold: true });
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Gander hi"), { interruptible });
    await flush(100);
    expect(interruptible).toHaveBeenCalledTimes(1);
    const process = goose();
    expect(process?.cancelled).toEqual([]);
    await interruptible.mock.calls[0]?.[0]();
    await flush(100);
    expect(process?.cancelled).toEqual([process?.turns[0]?.sessionId]);
  });

  it("tells a subscriber when a new conversation's first turn starts working", async () => {
    const { deliver, goose, runtime } = setup({ hold: true });
    // As a view does: each notification reads the snapshot again.
    runtime.subscribe(() => void runtime.sessions(self));
    expect(runtime.sessions(self)).toEqual([]);
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(goose()?.turns).toHaveLength(1);
    expect(runtime.sessions(self)).toMatchObject([{ busy: true }]);
    goose()?.turns[0]?.finish();
    await flush(100);
    expect(runtime.sessions(self)).toMatchObject([{ busy: false }]);
  });

  it("posts a channel session's burst once, in the latest message's thread", async () => {
    const reply = (id: string, root: EventData): RelayEvent =>
      message(id, "@Gander", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
          ["p", self],
        ],
      });
    const one = message("1", "First thread");
    const two = message("2", "Second thread");
    const { deliver, goose, published } = setup({
      scope: "channel",
      hold: true,
      reply: "Forgot to send",
    });
    await deliver(reply("3", one));
    await flush(100);
    await deliver(reply("4", two));
    await flush(100);
    const process = goose();
    expect(process?.turns).toHaveLength(1);
    expect(process?.turns[0]?.steered).toHaveLength(1);
    process?.turns[0]?.finish();
    await flush(100);
    expect(published).toEqual([
      {
        kind: 9,
        content: "Forgot to send",
        tags: [
          ["h", channel],
          ["e", two.id, "", "reply"],
        ],
      },
    ]);
  });

  it("starts a session from the host's core memory, reading none from the relay", async () => {
    const { core, deliver, goose, memoryOpen } = setup({
      core: "I am Gander.",
    });
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    expect([...(goose()?.prompts.values() ?? [])].join()).toContain(
      "<core-memory>\nI am Gander.\n</core-memory>",
    );
    expect(core).toHaveBeenCalledWith(self);
    expect(memoryOpen).not.toHaveBeenCalled();
  });

  it("posts goose's own text in the thread, or at a Solo chat's top level", async () => {
    const plain = setup({ reply: "Plain answer" });
    await plain.deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(plain.published.map((event) => event.tags)).toEqual([
      [
        ["h", channel],
        ["e", "1".repeat(64), "", "reply"],
      ],
    ]);
    const solo = setup({ reply: "Plain answer", solo: new Set([channel]) });
    await solo.deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(solo.published.map((event) => event.tags)).toEqual([
      [["h", channel]],
    ]);
  });

  it("names the agent in a timer's prompt, so its session is listed as the agent's", async () => {
    const { runOnce, goose } = setup();
    await expect(
      runOnce("timer/daily", "Post the daily summary."),
    ).resolves.toEqual({ ok: true });
    expect(goose()?.turns.map((turn) => turn.text)).toEqual([
      standalonePrompt(self, "Post the daily summary."),
    ]);
  });

  it("switches a saved provider in the live session without restarting goose", async () => {
    const { agent, deliver, fake, runtime } = setup();
    const saved = (config: typeof DEFAULT_CONFIG) =>
      runtime.sync([{ ...agent, config } as unknown as Agent]);
    saved(DEFAULT_CONFIG);
    const first = message("1", "@Gander which model?");
    await deliver(first);
    await flush(100);
    saved({ ...DEFAULT_CONFIG, provider: "openai" });
    await deliver(
      message("2", "@Gander and now?", {
        tags: [
          ["h", channel],
          ["e", first.id, "", "reply"],
          ["p", self],
        ],
      }),
    );
    await flush(100);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.env).toMatchObject({ GOOSE_PROVIDER: null });
    expect(goose?.closed).toEqual([]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
    expect(goose?.configured).toEqual(["session-1 provider=openai"]);
  });

  it.each(["", "openai"])(
    "refreshes inherited defaults without replacing explicit provider %s",
    async (provider) => {
      const { agent, deliver, fake, runtime } = setup();
      runtime.sync([
        {
          ...agent,
          config: { ...DEFAULT_CONFIG, provider },
        } as unknown as Agent,
      ]);
      const first = message("1", "@Gander first");
      await deliver(first);
      await flush(100);
      runtime.defaultsChanged();
      await deliver(
        message("2", "@Gander next", {
          tags: [
            ["h", channel],
            ["e", first.id, "", "reply"],
            ["p", self],
          ],
        }),
      );
      await flush(100);
      expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
        "session-1",
        provider ? "session-1" : "session-2",
      ]);
    },
  );

  it("runs a mention on the agent's thinking level", async () => {
    const { deliver, fake } = setup();
    await deliver(message("1", "@Gander think"), {
      config: { ...DEFAULT_CONFIG, effort: "max" },
    });
    await flush(100);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 thinking_effort=max",
    ]);
  });

  it("runs a mention on the model its owner picked", async () => {
    const { deliver, fake } = setup();
    await deliver(message("1", "@Gander hi"), {
      config: { ...DEFAULT_CONFIG, provider: "openai" },
      model: "o3",
    });
    await flush(100);
    expect(fake.geese[0]?.configured).toEqual(["session-1 model=o3"]);
  });

  it("keeps goose while another agent runs, and stops it with the last", async () => {
    const { agent, deliver, fake, runtime } = setup();
    const other = { ...agent, pubkey: "d".repeat(64), name: "Drake" };
    const running = (...agents: (typeof agent)[]) =>
      runtime.sync(
        agents.map(
          (item) => ({ ...item, config: DEFAULT_CONFIG }) as unknown as Agent,
        ),
      );
    running(agent, other);
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    running(other);
    await flush(30);
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.killed).toBe(false);
    running();
    await flush(30);
    expect(goose?.killed).toBe(true);
    expect(fake.geese).toHaveLength(1);
  });
});

describe("goose memory reads", () => {
  it("does not share a read that started before a write", async () => {
    const pending: ((body: string) => void)[] = [];
    const read = vi.fn(
      () =>
        new Promise<{ entries: { slug: string; body: string }[] }>((done) =>
          pending.push((body) => done({ entries: [{ slug: "core", body }] })),
        ),
    );
    const relay = {
      snapshot: () => ({
        status: "ready",
        session: { agentMemories: { read } },
      }),
    } as unknown as RelayData;
    const runtime = new GooseRuntime(
      {} as Host,
      () => relay,
      async () => null,
    ) as unknown as {
      memories(pubkey: string, slug?: string): Promise<unknown>;
      forgetMemories(pubkey: string): void;
    };
    const before = runtime.memories(self, "core");
    runtime.forgetMemories(self);
    const after = runtime.memories(self, "core");
    expect(read).toHaveBeenCalledTimes(2);
    pending[0]?.("old");
    await expect(before).resolves.toEqual({
      entries: [{ slug: "core", body: "old" }],
    });
    // The old read finishing must not drop the newer one.
    void runtime.memories(self, "core");
    expect(read).toHaveBeenCalledTimes(2);
    pending[1]?.("new");
    await expect(after).resolves.toEqual({
      entries: [{ slug: "core", body: "new" }],
    });
  });

  it("gives a tool the partial listing a slow native read answers", async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on real time; put it on the fake clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    try {
      const relay = {
        snapshot: () => ({
          status: "ready",
          session: { agentMemories: slowMemories(alice) },
        }),
      } as unknown as RelayData;
      const runtime = new GooseRuntime(
        {} as Host,
        () => relay,
        async () => null,
      ) as unknown as {
        memories(
          pubkey: string,
          slug?: string,
        ): ReturnType<BuzzClient["memories"]>;
      };
      const client = {
        memories: (slug?: string) => runtime.memories(self, slug),
      } as unknown as BuzzClient;
      const reply = callTool(client, {}, "mem_get", {});
      await vi.advanceTimersByTimeAsync(9_500);
      await expect(reply).resolves.toMatch(
        /^mem\/a .*\nThis list is incomplete: some memory could not be read\.$/,
      );
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

/** A native read that pages until its deadline and answers partial at 9.5
 * seconds, behind the session's real serialized memory reads. */
function slowMemories(viewer: string) {
  return createAgentMemories(
    () =>
      new Promise((done) =>
        setTimeout(
          () =>
            done({
              entries: [
                {
                  slug: "mem/a",
                  body: "a",
                  eventId: "e".repeat(64),
                  createdAt: 1,
                },
              ],
              partial: true,
            }),
          9_500,
        ),
      ),
    viewer,
    () => true,
  ).capability;
}

it("hands a Solo chat's Canvas to each turn, and a shared channel's to none", async () => {
  const solo = setup({ solo: new Set([channel]), canvas: "Use tokens." });
  await solo.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(solo.goose()?.turns[0]?.text).toContain(
    "<workspace-canvas>\nThis Solo chat's Canvas",
  );
  expect(solo.goose()?.turns[0]?.text).toContain("Use tokens.");
  // A cleared Canvas replaces it with an explicit "none".
  const cleared = setup({ solo: new Set([channel]), canvas: "" });
  await cleared.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(cleared.goose()?.turns[0]?.text).toContain(
    "Disregard any earlier workspace Canvas",
  );
  const shared = setup({ canvas: "Steer me" });
  await shared.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(shared.goose()?.turns[0]?.text).not.toContain("workspace-canvas");
});
