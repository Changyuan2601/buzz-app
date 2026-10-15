import { describe, expect, it, vi } from "vitest";
import { TOP_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import type { Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { fakeSpawn, flush } from "./goose-testing";
import { DEFAULT_CONFIG, GooseRuntime, sessionTitle } from "./runtime";

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
    /** Channels filed in the owner's Me; the owner is the viewer. */
    me?: Set<string>;
    hold?: boolean;
    reply?: string;
    thread?: readonly EventData[];
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
    agentMemories: { open: () => memories },
    channels: {
      list: () => ({
        channels: [
          { id: channel, name: "general", channelType: "stream", members: [] },
        ],
      }),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => new Map(),
    },
    mePlacement: {
      state: { status: "ready" } as { status: string; error?: string },
      snapshot: () => session.mePlacement.state,
      refresh: vi.fn(async () => {}),
      has: (id: string) => !!options.me?.has(id),
    },
  };
  const relay = {
    snapshot: () => ({ status: "ready", session, viewer: alice }),
  } as unknown as RelayData;
  const runtime = new GooseRuntime(host, () => relay);
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
  const deliver = (event: RelayEvent) =>
    runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config: DEFAULT_CONFIG,
      signal: new AbortController().signal,
      workingUntil: () => undefined,
    } as unknown as Delivery);
  const goose = () => fake.geese.find((process) => process.turns.length);
  return {
    agent,
    deliver,
    fake,
    goose,
    published,
    read,
    placement: session.mePlacement,
  };
}

describe("GooseRuntime", () => {
  it("continues an owner's Me chat as one channel session posted at the top level", async () => {
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
      me: new Set([channel]),
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
    // Each mention reports the failure, at the chat's top level.
    const report = [
      ["h", channel],
      ["p", alice],
    ];
    expect(published.map((event) => event.tags)).toEqual([report, report]);
  });

  it("posts goose's own text in the thread, or at a Me chat's top level", async () => {
    const plain = setup({ reply: "Plain answer" });
    await plain.deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(plain.published.map((event) => event.tags)).toEqual([
      [
        ["h", channel],
        ["e", "1".repeat(64), "", "reply"],
      ],
    ]);
    const me = setup({ reply: "Plain answer", me: new Set([channel]) });
    await me.deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(me.published.map((event) => event.tags)).toEqual([[["h", channel]]]);
  });

  it("fails a mention it cannot place until the placement can be read", async () => {
    const { deliver, fake, placement, published } = setup();
    placement.state = { status: "error", error: "Recipe read failed" };
    await expect(deliver(message("1", "@Gander hi"))).rejects.toThrow(
      "Couldn't read your Solo chats to tell where to answer (Recipe read failed). Try again.",
    );
    expect(placement.refresh).toHaveBeenCalledOnce();
    expect(fake.geese).toEqual([]);
    expect(published).toEqual([]);
  });
});
