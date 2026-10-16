// ACP agents' turns, end to end against a fake plain-ACP harness.
import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import { flush } from "../goose/goose-testing";
import { fakeHarness } from "./acp-testing";
import { approve, type Config, DEFAULT_CONFIG } from "./config";
import { AcpRuntime } from "./runtime";

const self = "c".repeat(64);
const alice = "a".repeat(64);
const mallory = "b".repeat(64);
const channel = "chan-1";
const INSTRUCTIONS = "Always answer in haiku.";

const message = (id: string, content: string, pubkey = alice): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
  }) as RelayEvent;

const confirmed = (value: Partial<Config> = {}) =>
  approve({
    ...DEFAULT_CONFIG,
    preset: "opencode",
    command: "opencode",
    args: ["acp"],
    instructions: INSTRUCTIONS,
    ...value,
  });

/** A runtime for one of Alice's agents in `channel`, on a fake harness. */
function setup(options: Parameters<typeof fakeHarness>[0] = {}) {
  const fake = fakeHarness(options);
  const host = { spawn: fake.spawn, serveMcp: fake.serve } as unknown as Host;
  const session = {
    read: vi.fn(async () => []),
    channels: {
      list: () => ({
        channels: [
          { id: channel, name: "general", channelType: "stream", members: [] },
        ],
      }),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: { ensure: vi.fn(async () => {}), snapshot: () => new Map() },
    agentMemories: { read: vi.fn(async () => ({ entries: [] })) },
    mePlacement: {
      snapshot: () => ({ status: "ready" }),
      refresh: vi.fn(async () => {}),
      has: () => false,
    },
  };
  const relay = {
    snapshot: () => ({ status: "ready", session, viewer: alice }),
  } as unknown as RelayData;
  const runtime = new AcpRuntime(host, () => relay);
  const published: { content: string; tags: string[][] }[] = [];
  const agent = {
    pubkey: self,
    name: "Opal",
    owner: alice,
    type: "buzz.acp/acp",
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return { ...message("9", template.content), ...template };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
  };
  const deliver = (
    event: RelayEvent,
    config: Config,
    signal = new AbortController().signal,
  ) => {
    const ignored = vi.fn();
    const run = runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config,
      signal,
      workingUntil: () => undefined,
      ignored,
    } as unknown as Delivery);
    return { run, ignored };
  };
  const sync = (config: Config) =>
    runtime.sync([
      { ...agent, config } as unknown as Parameters<
        AcpRuntime["sync"]
      >[0][number],
    ]);
  return { fake, runtime, deliver, sync, published };
}

describe("AcpRuntime", () => {
  it("runs an owner's mention in the confirmed harness, with Buzz tools over HTTP MCP", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    expect(harness?.options.args).toEqual(["opencode", "acp"]);
    const [opened] = harness?.opened ?? [];
    expect(opened?.mcpServers).toEqual([
      expect.objectContaining({ type: "http", name: "buzz" }),
    ]);
    // No extension `_meta`, and no standard prompt it didn't advertise.
    expect(opened).not.toHaveProperty("_meta");
    expect(opened).not.toHaveProperty("systemPrompt");
    const sessionId = harness?.turns[0]?.sessionId ?? "";
    const listed = await harness?.mcp(sessionId, "tools/list");
    const result = listed?.result as { tools?: { name: string }[] } | undefined;
    expect(result?.tools?.map((tool) => tool.name)).toContain("send");
  });

  it("leads only a new session's first prompt with the instructions", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await flush(50);
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    const [one, two] = fake.harnesses[0]?.turns ?? [];
    expect(one?.text).toContain(INSTRUCTIONS);
    expect(one?.text).toContain("@Opal one");
    expect(two?.sessionId).toBe(one?.sessionId);
    expect(two?.text).toContain("@Opal two");
    expect(two?.text).not.toContain(INSTRUCTIONS);
  });

  it("sends the instructions as ACP's appended system prompt when advertised", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
      },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [opened] = fake.harnesses[0]?.opened ?? [];
    const prompt = opened?.systemPrompt as {
      mode: string;
      content: { text: string }[];
    };
    expect(prompt.mode).toBe("append");
    expect(prompt.content[0]?.text).toContain(INSTRUCTIONS);
    expect(fake.harnesses[0]?.turns[0]?.text).not.toContain(INSTRUCTIONS);
  });

  it("closes sessions with session/close only when advertised", async () => {
    for (const close of [false, true]) {
      const config = await confirmed();
      const { fake, runtime, deliver, sync } = setup({
        capabilities: {
          mcpCapabilities: { http: true },
          ...(close && { sessionCapabilities: { close: {} } }),
        },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      await flush(50);
      runtime.dispose();
      await flush(50);
      const harness = fake.harnesses[0];
      expect(harness?.sent("session/cancel")).toHaveLength(1);
      expect(harness?.sent("session/close")).toHaveLength(close ? 1 : 0);
      expect(fake.servers.every((server) => server.closed)).toBe(true);
      expect(harness?.killed).toBe(true);
    }
  });

  it("ignores a mention from someone other than the owner", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    const { run, ignored } = deliver(
      message("1", "@Opal rm -rf", mallory),
      config,
    );
    await run;
    await flush(50);
    expect(ignored).toHaveBeenCalled();
    expect(fake.harnesses).toEqual([]);
  });

  it("says in the thread that it can't run an unconfirmed launch", async () => {
    const config = { ...(await confirmed()), command: "edited" };
    const { fake, deliver, sync, published } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toContain(
      "Confirm this agent's command in its settings.",
    );
    expect(fake.harnesses).toEqual([]);
  });

  it("says in the thread when the harness refuses Buzz tools", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({
      capabilities: { mcpCapabilities: { http: false } },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toContain(
      "This OpenCode cannot reach Buzz tools (no HTTP MCP support)",
    );
  });

  it("restarts the harness when its launch changes, and keeps it otherwise", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    sync({ ...config, instructions: "Be brief." });
    await flush(50);
    expect(fake.harnesses[0]?.killed).toBe(false);
    const next = await confirmed({ args: ["acp", "--port", "0"] });
    sync(next);
    await flush(50);
    expect(fake.harnesses[0]?.killed).toBe(true);
    await deliver(message("2", "@Opal again"), next).run;
    await vi.waitFor(() => expect(fake.harnesses[1]?.turns).toHaveLength(1));
    expect(fake.harnesses[1]?.options.args).toEqual([
      "opencode",
      "acp",
      "--port",
      "0",
    ]);
  });

  it("never queues on a busy session once its launch changes", async () => {
    for (const approved of [true, false]) {
      const config = await confirmed();
      const { fake, deliver, sync, published } = setup({
        hold: true,
        holdExit: true,
      });
      sync(config);
      const first = message("1", "@Opal hello");
      await deliver(first, config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const edited = { ...config, args: ["acp", "--port", "0"] };
      const next = approved ? await confirmed({ args: edited.args }) : edited;
      sync(next);
      // The old process is killed but has not exited, and its turn is open.
      await vi.waitFor(() => expect(fake.harnesses[0]?.killed).toBe(true));
      // In the same conversation as the turn still running.
      const reply = message("2", "@Opal again");
      reply.tags.push(["e", first.id, "", "reply"]);
      await deliver(reply, next).run;
      if (approved) {
        await vi.waitFor(() =>
          expect(fake.harnesses[1]?.turns).toHaveLength(1),
        );
        expect(fake.harnesses[1]?.turns[0]?.text).toContain("@Opal again");
      } else
        await vi.waitFor(() =>
          expect(published.map((p) => p.content).join("\n")).toContain(
            "Confirm this agent's command in its settings.",
          ),
        );
      expect(fake.harnesses[0]?.sent("session/prompt")).toHaveLength(1);
    }
  });

  it("leaves nothing running when a delivery is cancelled while the harness starts", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({
      silent: ["initialize"],
    });
    sync(config);
    const cancel = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await deliver(message("1", "@Opal hello"), config, cancel.signal).run;
      // The approval digest resolves outside the fake clock.
      while (!fake.harnesses[0]?.sent("initialize").length)
        await new Promise((resolve) => setImmediate(resolve));
      cancel.abort(new Error("cancelled"));
      // The start is shared by the agent's messages, so the cancel gives up
      // only this one; the unanswered start is then bounded and killed.
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(fake.harnesses[0]?.killed).toBe(true));
    await flush(50);
    expect(fake.harnesses).toHaveLength(1);
    expect(fake.harnesses[0]?.sent("session/new")).toEqual([]);
    expect(fake.servers.every((server) => server.closed)).toBe(true);
  });

  it("adds the preset's sign-in hint only when the first turn needs a login", async () => {
    for (const code of [-32000, -32603]) {
      const config = await confirmed();
      const { deliver, sync, published } = setup({
        promptError: { code, message: "No luck" },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(published).toHaveLength(1));
      const [report] = published;
      expect(report?.content).toContain("No luck");
      if (code === -32000)
        expect(report?.content).toContain("Run `opencode auth login`.");
      else expect(report?.content).not.toContain("opencode auth login");
    }
  });
});
