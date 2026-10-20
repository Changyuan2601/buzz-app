// ACP agents' turns, end to end against a fake plain-ACP harness.
import { describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import { flush } from "../goose/goose-testing";
import { fakeHarness } from "./acp-testing";
import { approve, type Config, DEFAULT_CONFIG } from "./config";
import { missing } from "./harness";
import { AcpRuntime } from "./runtime";

const appClient = vi.hoisted(() => vi.fn());
vi.mock("../../buzz-mcp/app-client", async (actual) => {
  const real = await actual<typeof import("../../buzz-mcp/app-client")>();
  return {
    ...real,
    appClient: appClient.mockImplementation(real.appClient),
  };
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const mallory = "b".repeat(64);
const channel = "chan-1";
const INSTRUCTIONS = "Always answer in haiku.";

const FAILED = "⚠️ I couldn't finish that. Details are in my activity.";

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
function setup(
  options: Parameters<typeof fakeHarness>[0] = {},
  {
    core = async () => null,
    added = () => [],
    read = async () => [] as RelayEvent[],
    solo = false,
    canvas,
  }: {
    solo?: boolean;
    /** The channel's Canvas. */
    canvas?: string;
    core?: () => Promise<string | null | undefined>;
    added?: () => readonly AddedTool[];
    read?: () => Promise<RelayEvent[]>;
  } = {},
) {
  const fake = fakeHarness(options);
  const host = {
    spawn: fake.spawn,
    serveMcp: fake.serve,
    resolveDirectory: async (path: string) => path,
  } as unknown as Host;
  const session = {
    read: vi.fn(read),
    channels: {
      list: () => ({
        channels: [
          {
            id: channel,
            name: "general",
            channelType: solo ? "solo" : "stream",
            members: [],
          },
        ],
      }),
    },
    relayAuthor: "relay-author",
    audienceAuthorityCommunity: "audience-community",
    workflowAuthority: "workflow-authority",
    channelWrites: { startingCanvas: () => undefined },
    canvas: {
      available: canvas !== undefined,
      read: vi.fn(async () =>
        canvas === undefined
          ? null
          : {
              pubkey: alice,
              kind: 40100,
              created_at: 1,
              tags: [],
              content: canvas,
            },
      ),
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
  const runtime = new AcpRuntime(host, () => relay, core, added);
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
  const workingUntil = vi.fn((_done: Promise<unknown>) => undefined);
  const deliver = (
    event: RelayEvent,
    config: Config,
    signal = new AbortController().signal,
    extra: Partial<Delivery> = {},
  ) => {
    const ignored = vi.fn();
    const run = runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config,
      signal,
      workingUntil,
      ignored,
      ...extra,
    } as unknown as Delivery);
    return { run, ignored };
  };
  const sync = (config: Config) =>
    runtime.sync([
      { ...agent, config } as unknown as Parameters<
        AcpRuntime["sync"]
      >[0][number],
    ]);
  return { fake, runtime, deliver, sync, published, workingUntil };
}

/** Resolves once a turn has settled and its report step has finished. */
async function reported(
  runtime: { subscribe(listener: () => void): () => void },
  workingUntil: { mock: { calls: unknown[][] } },
) {
  await vi.waitFor(() => expect(workingUntil.mock.calls).toHaveLength(1));
  await workingUntil.mock.calls[0]?.[0];
  // Subscribed before the report step's continuation runs; that step ends by
  // notifying, after any post it makes.
  await new Promise<void>((resolve) => {
    const stop = runtime.subscribe(() => {
      stop();
      resolve();
    });
  });
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
    // Shared-session tools act with the community's authorities, as Goose's do.
    expect(appClient).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        relayAuthor: "relay-author",
        audienceAuthorityCommunity: "audience-community",
        signingAuthority: "workflow-authority",
      }),
    );
  });

  it("hands a Solo chat's Canvas to each turn, and a shared channel's to none", async () => {
    const config = await confirmed();
    for (const solo of [true, false]) {
      const { fake, deliver, sync } = setup(
        {},
        { solo, canvas: "Use tokens." },
      );
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const text = fake.harnesses[0]?.turns[0]?.text ?? "";
      if (solo) {
        expect(text).toContain("<workspace-canvas>");
        expect(text).toContain("Use tokens.");
      } else expect(text).not.toContain("workspace-canvas");
    }
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

  it.each([
    ["a provider error", "Request failed: https://p.test/v1?key=SENTINEL"],
    ["a plain answer", "Here is my answer, SENTINEL"],
  ])(
    "posts nothing for %s the harness wrote without send",
    async (_, chunk) => {
      const config = await confirmed();
      const { runtime, deliver, sync, published, workingUntil } = setup({
        chunk,
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await reported(runtime, workingUntil);
      expect(published).toEqual([]);
    },
  );

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

  it("gives a missing program's install hint, and nothing it wrote", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({ exitCode: 127 });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(
      `${FAILED} ${missing(config.preset, config.command)}`,
    );
  });

  it("says only that it failed when the harness refuses Buzz tools", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({
      capabilities: { mcpCapabilities: { http: false } },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("leads a new session with the core memory the host keeps", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup(
      {},
      { core: async () => "Prefers tabs." },
    );
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(fake.harnesses[0]?.turns[0]?.text).toContain("Prefers tabs.");
  });

  it("lists plugin-added tools, and reopens an idle session when they change", async () => {
    const tool = (name: string): AddedTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      call: async () => ({ content: [] }) as never,
    });
    let added: readonly AddedTool[] = [tool("pin")];
    const config = await confirmed();
    const { fake, deliver, sync } = setup({}, { added: () => added });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    const one = harness?.turns[0]?.sessionId ?? "";
    const listed = await harness?.mcp(one, "tools/list");
    const result = listed?.result as { tools?: { name: string }[] } | undefined;
    expect(result?.tools?.map((t) => t.name)).toContain("pin");
    await flush(50);
    added = [tool("pin"), tool("star")];
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    expect(harness?.turns[1]?.sessionId).not.toBe(one);
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

  it("asks for the message again when the launch changes while its conversation loads", async () => {
    const config = await confirmed();
    let loaded!: (events: RelayEvent[]) => void;
    const { fake, deliver, sync, published } = setup(
      {},
      { read: () => new Promise((resolve) => (loaded = resolve)) },
    );
    sync(config);
    const root = message("1", "@Opal hello");
    const reply = message("2", "@Opal again");
    reply.tags.push(["e", root.id, "", "reply"]);
    const { run } = deliver(reply, config);
    await vi.waitFor(() => expect(loaded).toBeDefined());
    const next = await confirmed({ args: ["acp", "--port", "0"] });
    sync(next);
    loaded([]);
    await run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toContain("settings changed");
    expect(published[0]?.content).toContain("Send your message again.");
    expect(published[0]?.content).not.toContain("was stopped");
    // Neither the old launch nor the new one was shown the message.
    for (const harness of fake.harnesses)
      expect(harness.sent("session/prompt")).toHaveLength(0);
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
      expect(report?.content).toBe(
        code === -32000 ? `${FAILED} Run \`opencode auth login\`.` : FAILED,
      );
    }
  });

  it("keeps a failed turn's error in its activity, out of the channel", async () => {
    const error = "Request failed: https://p.test/v1?key=SENTINEL";
    for (const code of [-32000, -32603]) {
      const config = await confirmed();
      const { runtime, deliver, sync, published, workingUntil } = setup({
        promptError: { code, message: error },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await reported(runtime, workingUntil);
      // The host records what `done` settles with in the turn's activity.
      expect(await workingUntil.mock.calls[0]?.[0]).toMatchObject({
        ok: false,
        error: expect.stringContaining("SENTINEL"),
      });
      expect(published).toHaveLength(1);
      expect(published[0]?.content).not.toContain("SENTINEL");
    }
  });

  it("hands the host a stopper that cancels the mention's running turn", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({ hold: true });
    sync(config);
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Opal hi"), config, undefined, {
      interruptible,
    }).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(interruptible).toHaveBeenCalledTimes(1);
    const harness = fake.harnesses[0];
    expect(harness?.sent("session/cancel")).toEqual([]);
    await interruptible.mock.calls[0]?.[0]();
    await vi.waitFor(() =>
      expect(harness?.sent("session/cancel")).toHaveLength(1),
    );
  });

  it("gives no sign-in hint when a refusal follows the sign-in error", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, published } = setup({ hold: true });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    // Queued behind the running prompt, so one turn answers both.
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await flush(50);
    const harness = fake.harnesses[0];
    harness?.turns[0]?.fail(-32000, "Authentication required");
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    harness?.turns[1]?.finish("refusal");
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("gives no sign-in hint to a refusal after a sign-in error while the session opened", async () => {
    const config = await confirmed();
    let open!: () => void;
    const opening = new Promise<void>((resolve) => (open = resolve));
    const { fake, deliver, sync, published } = setup({ hold: true, opening });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.opened).toHaveLength(1));
    // Both arrive before the session has seen a message, so both are first.
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    open();
    const harness = fake.harnesses[0];
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(1));
    harness?.turns[0]?.fail(-32000, "Authentication required");
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    harness?.turns[1]?.finish("refusal");
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("gives no sign-in hint for a later turn that needs a login", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, published } = setup({
      promptError: {
        code: -32000,
        message: "Authentication required",
        from: 1,
      },
    });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await flush(50);
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(fake.harnesses).toHaveLength(1);
    expect(published[0]?.content).toBe(FAILED);
  });
});
