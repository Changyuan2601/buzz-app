import { TOOLS } from "../../buzz-mcp/tools";
import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import {
  compileFilter,
  watchMatches,
  type EventWatch,
} from "../../features/agents/attention";
import type { HostProcessOptions } from "../../features/host/service";
import {
  IDLE_MS,
  historyTitle,
  conversationKey,
  gooseEnv,
  instructions,
  type MeshAgentConfig,
  type MeshAgentDeps,
  MeshAgentRuntime,
  meshAgentConfig,
  salvageReply,
  turnTools,
} from "./meshAgent";

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const EVENT = {
  id: "c".repeat(64),
  pubkey: OWNER,
  kind: 9,
  created_at: 1,
  content: "hello",
  tags: [["h", "chan"]],
  sig: "",
};

/** A fake helper speaking the ACP subset the runtime uses. */
type Seen = {
  env?: HostProcessOptions["env"];
  calls: { method: string; params: Record<string, unknown> }[];
  agents: number;
  bridges: number;
  kills?: number;
  bridgeKills?: number;
  /** Sends a line from goose's relay into the plugin's bridge end. */
  relay?: (message: object) => void;
  bridgeOut: string[];
  failLoad?: boolean;
  failSteer?: boolean;
  promptGate?: () => Promise<void>;
  beforeRequest?: (method: string) => Promise<void>;
  /** Replaces the prompt's one reply chunk: a string is a text chunk, null a
   * tool call. */
  updates?: (string | null)[];
};
function fakeSpawn(reply: string, seen: Seen): MeshAgentDeps["spawn"] {
  let sessions = 0;
  return vi.fn(async (id: string, options?: HostProcessOptions) => {
    options ??= {};
    if (id === "workspace" || id === "bridge") {
      if (id === "bridge") {
        seen.bridges++;
        seen.relay = (message) =>
          options.onStdout?.(`${JSON.stringify(message)}\n`);
        queueMicrotask(() =>
          options.onStdout?.(
            `${JSON.stringify({ command: "/app/buzz-foundation", socket: "/t/bt-1/s", token: "tok" })}\n`,
          ),
        );
      }
      if (id === "workspace")
        queueMicrotask(() =>
          options.onStdout?.(
            `/home/u/${String(options.cwd).replace("~/", "")}\n`,
          ),
        );
      return {
        exited:
          id === "workspace"
            ? Promise.resolve(0)
            : new Promise<number | null>(() => {}),
        end: async () => {},
        kill: async () => {
          if (id === "bridge") seen.bridgeKills = (seen.bridgeKills ?? 0) + 1;
        },
        write: async (line: string) => {
          seen.bridgeOut.push(line);
        },
      };
    }
    seen.agents++;
    seen.env = options.env;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const out = (message: object) =>
      queueMicrotask(() => options.onStdout?.(`${JSON.stringify(message)}\n`));
    return {
      exited,
      end: async () => {},
      kill: async () => {
        seen.kills = (seen.kills ?? 0) + 1;
        resolveExit(null);
      },
      write: async (line: string) => {
        const { id, method, params } = JSON.parse(line);
        seen.calls.push({ method, params });
        await seen.beforeRequest?.(method);
        if (method === "session/close") out({ id, result: {} });
        if (method === "initialize") out({ id, result: {} });
        if (method === "_goose/unstable/session/system-prompt/set")
          out({ id, result: {} });
        if (method === "session/new")
          out({ id, result: { sessionId: `s${++sessions}` } });
        if (method === "session/load") {
          if (seen.failLoad) out({ id, error: { message: "no such session" } });
          else {
            // History replay must not leak into the reply.
            out({
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "OLD " },
                },
              },
            });
            out({ id, result: {} });
          }
        }
        if (method === "_goose/unstable/session/steer") {
          out(
            seen.failSteer
              ? { id, error: { message: "run ended" } }
              : { id, result: { runId: "run-1" } },
          );
        }
        if (method === "session/prompt") {
          out({
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "session_info_update",
                _meta: { goose: { activeRunId: "run-1" } },
              },
            },
          });
          await seen.promptGate?.();
          for (const item of seen.updates ?? [reply])
            out({
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update:
                  item === null
                    ? { sessionUpdate: "tool_call", toolCallId: "t" }
                    : {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: item },
                      },
              },
            });
          out({ id, result: { stopReason: "end_turn" } });
        }
      },
    };
  });
}

function setup(
  over: Partial<MeshAgentDeps> = {},
  from = OWNER,
  config: object = { prompt: "be brief", mode: "agent", buzz: false },
) {
  const seen: Seen = { calls: [], agents: 0, bridges: 0, bridgeOut: [] };
  const publish = vi.fn(async (event: object) => event);
  const query = vi.fn(async () => [] as object[]);
  const deps: MeshAgentDeps = {
    spawn: fakeSpawn("hi from mesh", seen),
    origin: () => "https://community.example",
    prepare: async () => ({
      baseUrl: "http://127.0.0.1:19337/v1",
      model: "mesh",
      lease: "L1",
    }),
    current: async () => true,
    chat: vi.fn(async () => "chat answer"),
    ...over,
  };
  const delivery = (event: object = {}) =>
    ({
      trigger: { type: "mention", event: { ...EVENT, pubkey: from, ...event } },
      channelId: "chan",
      agent: { pubkey: AGENT, name: "M", owner: OWNER, publish, query },
      config,
      signal: new AbortController().signal,
    }) as unknown as Delivery<MeshAgentConfig>;
  const runtime = new MeshAgentRuntime(deps);
  return { deps, delivery, publish, query, seen, runtime };
}
const inThread = (id: string, at: number) => ({
  id,
  created_at: at,
  tags: [
    ["h", "chan"],
    ["e", "9".repeat(64), "", "root"],
    ["e", "9".repeat(64), "", "reply"],
  ],
});
const prompts = (seen: Seen) =>
  seen.calls
    .filter((c) => c.method === "session/prompt")
    .map((c) => ({
      session: c.params.sessionId,
      text: (c.params.prompt as { text: string }[])[0]?.text,
    }));

describe("Mesh agent runtime", () => {
  it("posts only the message after the last tool call, not the narration", async () => {
    const { delivery, publish, seen, runtime } = setup();
    seen.updates = ["Let me check. ", null, "The answer is 4."];
    await runtime.run(delivery());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "The answer is 4.",
    });
  });

  it("posts the last message when the turn ends on a tool call", async () => {
    const { delivery, publish, seen, runtime } = setup();
    seen.updates = ["Here it is: 4.", null];
    await runtime.run(delivery());
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "Here it is: 4.",
    });
  });

  it("posts a written-out send call's text instead of the raw call", async () => {
    const { delivery, publish, seen, runtime } = setup();
    seen.updates = [
      '<tool_call>{"name": "send", "arguments": {"text": "Hello there"}}</tool_call>',
    ];
    await runtime.run(delivery());
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "Hello there",
    });
  });

  it("publishes goose's reply as the agent, threaded to the mention", async () => {
    const { delivery, publish, seen, runtime } = setup();
    await runtime.run(delivery());
    expect(publish).toHaveBeenCalledWith({
      kind: 9,
      content: "hi from mesh",
      tags: [
        ["h", "chan"],
        ["e", EVENT.id, "", "reply"],
        ["p", OWNER],
      ],
    });
    expect(seen.env).toMatchObject({
      GOOSE_PROVIDER: "openai",
      GOOSE_MODEL: "mesh",
      OPENAI_HOST: "http://127.0.0.1:19337",
      OPENAI_BASE_PATH: "v1/chat/completions",
      OPENAI_API_KEY: "mesh-local",
      GOOSE_PATH_ROOT: "/home/u/.local/share/buzz-mesh-goose",
      BUZZ_PRIVATE_KEY: null,
      BUZZ_AUTH_TAG: null,
    });
    expect(seen.calls.find((c) => c.method === "session/new")?.params).toEqual({
      cwd: "/home/u/.buzz",
      mcpServers: [],
      _meta: {
        sessionTitle: historyTitle(AGENT, {
          channelId: "chan",
          root: EVENT.id,
        }),
      },
    });
    expect(
      seen.calls.find(
        (c) => c.method === "_goose/unstable/session/system-prompt/set",
      )?.params,
    ).toEqual({
      sessionId: "s1",
      mode: "append",
      key: "buzz",
      text: "be brief",
    });
  });

  it("keeps one goose and one session per thread across turns, sending only what's new", async () => {
    const { delivery, query, seen, runtime } = setup();
    const root = {
      ...EVENT,
      id: "9".repeat(64),
      created_at: 1,
      content: "the root",
    };
    query.mockResolvedValueOnce([root]);
    await runtime.run(delivery(inThread("1".repeat(64), 2)));
    query.mockResolvedValueOnce([
      root,
      { ...EVENT, ...inThread("1".repeat(64), 2) },
      {
        ...EVENT,
        pubkey: AGENT,
        content: "hi from mesh",
        ...inThread("2".repeat(64), 3),
      },
    ]);
    await runtime.run(
      delivery({ ...inThread("3".repeat(64), 4), content: "and then?" }),
    );
    expect(seen.agents).toBe(1);
    expect(seen.calls.filter((c) => c.method === "session/new")).toHaveLength(
      1,
    );
    const [first, second] = prompts(seen);
    expect(first?.text).toContain("the root");
    expect(second?.session).toBe(first?.session);
    expect(second?.text).not.toContain("Earlier");
    expect(second?.text).toContain("and then?");
  });

  it("gives another thread its own session on the same goose", async () => {
    const { delivery, seen, runtime } = setup();
    await runtime.run(delivery());
    await runtime.run(delivery({ id: "e".repeat(64) }));
    expect(seen.agents).toBe(1);
    expect(new Set(prompts(seen).map((p) => p.session)).size).toBe(2);
  });

  it.each([false, true])(
    "recreates the conversation when Buzz access changes from %s",
    async (buzz) => {
      const config = { mode: "agent", buzz };
      const { delivery, query, seen, runtime } = setup({}, OWNER, config);
      const root = {
        ...EVENT,
        id: "9".repeat(64),
        content: "Earlier question",
      };
      try {
        await runtime.run(delivery(inThread("first", 2)));
        config.buzz = !buzz;
        query.mockResolvedValueOnce([root]);
        await runtime.run(delivery(inThread("second", 3)));
        const sessions = seen.calls.filter(
          (call) => call.method === "session/new",
        );
        expect(sessions).toHaveLength(2);
        expect(sessions[1]?.params.mcpServers).toHaveLength(buzz ? 0 : 1);
        expect(seen.bridgeKills ?? 0).toBe(buzz ? 1 : 0);
        expect(seen.agents).toBe(1);
        expect(prompts(seen)[1]?.text).toContain("Earlier question");
        await runtime.run(delivery(inThread("third", 4)));
        expect(
          seen.calls.filter((call) => call.method === "session/new"),
        ).toHaveLength(2);
      } finally {
        runtime.dispose();
      }
    },
  );

  it.each([false, true])(
    "restart creates a fresh session with the current Buzz access (%s)",
    async (buzz) => {
      const first = setup({}, OWNER, { mode: "agent", buzz });
      await first.runtime.run(first.delivery());
      first.runtime.dispose();
      const second = setup({}, OWNER, { mode: "agent", buzz: !buzz });
      try {
        await second.runtime.run(second.delivery());
        expect(
          second.seen.calls.some((call) => call.method === "session/load"),
        ).toBe(false);
        expect(
          second.seen.calls.find((call) => call.method === "session/new")
            ?.params.mcpServers,
        ).toHaveLength(buzz ? 0 : 1);
      } finally {
        second.runtime.dispose();
      }
    },
  );

  it.each([
    '```json\n{"answer":42}\n```',
    'Here is the configuration:\n```json\n{"name":"example","arguments":{}}\n```',
    '{"text":"keep this JSON"}',
    '```json\n{"text":"keep this JSON"}\n```',
    '```\n{"answer":42}\n```',
  ])("publishes an ordinary JSON answer intact: %s", async (answer) => {
    const { delivery, seen, publish, runtime } = setup();
    seen.updates = [answer];
    try {
      await runtime.run(delivery({ content: "Give me JSON" }));
      expect(publish.mock.calls[0]?.[0]).toMatchObject({ content: answer });
    } finally {
      runtime.dispose();
    }
  });

  it("uses one session for the whole channel in channel scope", async () => {
    const { delivery, seen, runtime } = setup({}, OWNER, {
      mode: "agent",
      buzz: false,
      scope: "channel",
    });
    await runtime.run(delivery());
    await runtime.run(delivery({ id: "e".repeat(64) }));
    expect(new Set(prompts(seen).map((p) => p.session)).size).toBe(1);
  });

  it("starts a fresh conversation after a restart", async () => {
    const first = setup({});
    await first.runtime.run(first.delivery());
    first.runtime.dispose();
    const second = setup({});
    await second.runtime.run(second.delivery());
    expect(second.seen.calls.some((c) => c.method === "session/load")).toBe(
      false,
    );
    expect(second.seen.calls.some((c) => c.method === "session/new")).toBe(
      true,
    );
    expect(second.publish.mock.calls[0]?.[0]).toMatchObject({
      content: "hi from mesh",
    });
  });

  it("runs a conversation's turns one at a time", async () => {
    const { delivery, seen, runtime } = setup();
    await Promise.all([
      runtime.run(delivery()),
      runtime.run(delivery({ id: EVENT.id, created_at: 2 })),
    ]);
    expect(seen.calls.filter((c) => c.method === "session/new")).toHaveLength(
      1,
    );
    expect(prompts(seen)).toHaveLength(2);
  });

  it.each([false, true])(
    "steers a live turn, or queues exactly once if its run ended (%s)",
    async (failSteer) => {
      const { delivery, seen, runtime, publish } = setup();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      seen.failSteer = failSteer;
      seen.promptGate = async () => {
        entered();
        await gate;
      };
      const first = runtime.run(delivery(inThread("1".repeat(64), 1)));
      let second: Promise<void> | undefined;
      try {
        await started;
        const acknowledged = vi.fn();
        second = runtime.run({
          ...delivery({
            ...inThread("2".repeat(64), 2),
            content: "Use the new requirement",
          }),
          acknowledged,
        });
        await vi.waitFor(() =>
          expect(
            seen.calls.filter((call) => call.method.endsWith("/steer")),
          ).toHaveLength(1),
        );
        expect(prompts(seen)).toHaveLength(1);
        expect(
          seen.calls.find((call) => call.method.endsWith("/steer"))?.params,
        ).toMatchObject({ expectedRunId: "run-1", sessionId: "s1" });
        release();
        await Promise.all([first, second]);
        expect(prompts(seen)).toHaveLength(failSteer ? 2 : 1);
        expect(publish).toHaveBeenCalledTimes(failSteer ? 2 : 1);
        expect(acknowledged).toHaveBeenCalledTimes(failSteer ? 0 : 1);
      } finally {
        release();
        await Promise.all([first, second]);
        runtime.dispose();
      }
    },
  );

  it("keeps different conversations and access changes out of the active run", async () => {
    const { delivery, seen, runtime } = setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    seen.promptGate = async () => {
      entered();
      await gate;
    };
    const first = runtime.run(delivery(inThread("1".repeat(64), 1)));
    try {
      await started;
      const other = runtime.run(delivery({ id: "5".repeat(64) }));
      const changed = runtime.run({
        ...delivery(inThread("2".repeat(64), 2)),
        config: meshAgentConfig({ buzz: true }),
      });
      await vi.waitFor(() => expect(prompts(seen)).toHaveLength(2));
      release();
      await Promise.all([first, other, changed]);
      expect(
        seen.calls.filter((call) => call.method.endsWith("/steer")),
      ).toHaveLength(0);
      expect(prompts(seen)).toHaveLength(3);
    } finally {
      release();
      runtime.dispose();
    }
  });

  it("closes idle conversations and rebuilds their history without a saved-session load", async () => {
    vi.useFakeTimers();
    const { delivery, seen, runtime, query } = setup();
    try {
      await runtime.run(delivery(inThread("1".repeat(64), 1)));
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(seen.kills ?? 0).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      query.mockResolvedValue([{ ...EVENT, content: "earlier Buzz message" }]);
      await runtime.run(delivery(inThread("2".repeat(64), 2)));
      expect(
        seen.calls.filter((call) => call.method === "session/new"),
      ).toHaveLength(2);
      expect(
        seen.calls.filter((call) => call.method === "session/load"),
      ).toHaveLength(0);
      expect(prompts(seen).at(-1)?.text).toContain("earlier Buzz message");
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it("refreshes core memory on each turn and keeps Buzz instructions out of no-access agents", async () => {
    const coreMemory = vi
      .fn()
      .mockResolvedValueOnce("first memory")
      .mockResolvedValueOnce("updated memory");
    const { runtime, delivery, seen } = setup({ coreMemory }, OWNER, {
      buzz: true,
    });
    try {
      await runtime.run(delivery(inThread("1".repeat(64), 1)));
      await runtime.run(delivery(inThread("2".repeat(64), 2)));
      const prompts = seen.calls.filter((call) =>
        call.method.endsWith("system-prompt/set"),
      );
      expect(prompts[0]?.params.text).toContain("<core-memory>\nfirst memory");
      expect(prompts[1]?.params.text).toContain(
        "<core-memory>\nupdated memory",
      );
      expect(prompts[1]?.params.text).toContain("Incoming Turn Contract");
      expect(
        instructions(meshAgentConfig({ buzz: false }), "private memory"),
      ).not.toContain("private memory");
    } finally {
      runtime.dispose();
    }
  });

  it("answers in chat mode with one completion and no goose", async () => {
    const chat = vi.fn(async () => "chat answer");
    const { delivery, publish, query, seen, runtime } = setup({ chat }, OWNER, {
      prompt: "summarize",
      mode: "chat",
    });
    query.mockResolvedValueOnce([
      { ...EVENT, id: "9".repeat(64), content: "root", created_at: 0 },
      {
        ...EVENT,
        pubkey: AGENT,
        content: "earlier answer",
        ...inThread("2".repeat(64), 1),
      },
    ]);
    await runtime.run(delivery(inThread("1".repeat(64), 2)));
    expect(seen.agents).toBe(0);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ lease: "L1" }),
      [
        { role: "system", content: "summarize" },
        { role: "user", content: "[aaaaaaaa] root" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "[aaaaaaaa] hello" },
      ],
    );
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "chat answer",
    });
  });

  it("drops a reply whose lease went stale mid-turn", async () => {
    const { delivery, publish, runtime } = setup({
      current: async () => false,
    });
    await runtime.run(delivery());
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports unavailable shared compute instead of falling back", async () => {
    const spawn = vi.fn();
    const { delivery, publish, runtime } = setup({
      spawn,
      prepare: async () => {
        throw new Error("Shared compute inference did not become ready");
      },
    });
    await runtime.run(delivery());
    expect(spawn).not.toHaveBeenCalled();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("did not become ready"),
    });
  });

  it("ignores anyone but its owner", async () => {
    const { delivery, publish, runtime } = setup({}, "d".repeat(64));
    await runtime.run(delivery());
    expect(publish).not.toHaveBeenCalled();
  });

  it("answers a selected sender's watched reply in Chat mode, in the same thread", async () => {
    const sender = "d".repeat(64);
    const { delivery, publish, query, deps, seen, runtime } = setup(
      {},
      sender,
      {
        mode: "chat",
        prompt: "You are Palmer. Be concise.",
      },
    );
    query.mockResolvedValue([
      { ...EVENT, id: "9".repeat(64), content: "Which MUD is best?" },
    ]);
    const watch: EventWatch = {
      type: "event",
      interest_id: "follow",
      enabled: true,
      since: 1,
      channels: ["chan"],
      kinds: [9],
      filter: `author == "${sender}"`,
    };
    const reply = delivery({
      ...inThread("e".repeat(64), 2),
      content: "I recommend a time-travel MUD with branching histories.",
    });
    if (reply.trigger.type !== "mention") throw new Error("Expected message");
    const filter = compileFilter(watch.filter ?? "");
    expect(
      watchMatches(watch, { ...reply.trigger.event, pubkey: OWNER }, filter),
    ).toBe(false);
    expect(
      watchMatches(watch, { ...reply.trigger.event, pubkey: AGENT }, filter),
    ).toBe(false);
    expect(watchMatches(watch, reply.trigger.event, filter)).toBe(true);
    await runtime.run({
      ...reply,
      trigger: {
        ...reply.trigger,
        type: "watch",
        slug: "watch/follow",
        watch,
        interest: {
          type: "interest",
          instructions:
            "Respond to Moonpal's idea with one concrete improvement.",
        },
      },
    });
    expect(deps.chat).toHaveBeenCalledTimes(1);
    const messages = vi.mocked(deps.chat).mock.calls[0]?.[1];
    expect(messages?.[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining(
        "Respond to Moonpal's idea with one concrete improvement.",
      ),
    });
    expect(messages?.[0]?.content).toContain("You are Palmer. Be concise.");
    expect(messages?.[0]?.content).toContain("earlier messages are context");
    expect(messages?.at(-1)).toEqual({
      role: "user",
      content:
        "[dddddddd] I recommend a time-travel MUD with branching histories.",
    });
    expect(seen.agents).toBe(0);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "chat answer",
        tags: [
          ["h", "chan"],
          ["e", "9".repeat(64), "", "root"],
          ["e", "e".repeat(64), "", "reply"],
          ["p", sender],
        ],
      }),
    );
    // A later direct request must not inherit the previous watch's instructions.
    await runtime.run(
      delivery({ ...inThread("f".repeat(64), 3), pubkey: OWNER }),
    );
    expect(vi.mocked(deps.chat).mock.calls[1]?.[1]?.[0]).toEqual({
      role: "system",
      content: "You are Palmer. Be concise.",
    });
  });

  it.each([
    ["agent", "d".repeat(64), `author == "${"d".repeat(64)}"`],
    ["chat", "d".repeat(64), undefined],
    ["chat", "d".repeat(64), "true"],
    ["chat", "d".repeat(64), `author == "${"e".repeat(64)}"`],
    ["chat", "d".repeat(64), `author == "${"d".repeat(64)}" || true`],
    ["chat", AGENT, `author == "${AGENT}"`],
  ])(
    "refuses a non-owner watch in %s mode from %s with filter %s",
    async (mode, sender, filter) => {
      const { delivery, deps, publish, runtime } = setup({}, sender, { mode });
      const turn = delivery();
      if (turn.trigger.type !== "mention") throw new Error("Expected message");
      await runtime.run({
        ...turn,
        trigger: {
          ...turn.trigger,
          type: "watch",
          slug: "watch/follow",
          watch: {
            type: "event",
            interest_id: "follow",
            enabled: true,
            since: 1,
            channels: "all",
            kinds: [9],
            ...(filter === undefined ? {} : { filter }),
          },
        },
      });
      expect(deps.chat).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("keeps the Buzz bridge for the session with Buzz access, answering discovery but refusing calls between turns", async () => {
    const { delivery, publish, seen, runtime } = setup({}, OWNER, {
      prompt: "be brief",
    });
    await runtime.run(delivery());
    await runtime.run(delivery({ created_at: 2 }));
    expect(seen.bridges).toBe(1);
    const servers = seen.calls.find((c) => c.method === "session/new")?.params
      .mcpServers as object[];
    expect(servers).toEqual([
      {
        name: "buzz",
        command: "/app/buzz-foundation",
        args: ["--tool-relay"],
        env: [
          { name: "BUZZ_TOOL_SOCKET", value: "/t/bt-1/s" },
          { name: "BUZZ_TOOL_TOKEN", value: "tok" },
        ],
      },
    ]);
    seen.relay?.({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    seen.relay?.({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "send", arguments: { text: "late" } },
    });
    await vi.waitFor(() => expect(seen.bridgeOut).toHaveLength(2));
    const out = seen.bridgeOut.map((line) => JSON.parse(line));
    // Discovery works outside a turn (goose lists tools when it opens the
    // session); tool calls do not.
    expect(out.find((m) => m.id === 8)?.result.tools.length).toBeGreaterThan(0);
    expect(out.find((m) => m.id === 9)).toMatchObject({
      error: { message: "No turn is active" },
    });
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "hi from mesh",
    });
  });

  it("salvages replies from tool calls written as text", () => {
    expect(salvageReply("plain answer")).toBe("plain answer");
    expect(
      salvageReply('{"name":"send","arguments":{"text":"hi","final":true}}'),
    ).toBe("hi");
    expect(
      salvageReply(
        '```json\n{"function":{"name":"send","arguments":"{\\"text\\":\\"yo\\"}"}}\n```',
      ),
    ).toBe("yo");
    expect(
      salvageReply(
        'Done.\n<tool_call>{"name":"react","arguments":{"emoji":"👍"}}</tool_call>',
      ),
    ).toBe("Done.");
  });

  it("keys conversations like Codex and Claude Code", () => {
    const reply = { ...EVENT, ...inThread("1".repeat(64), 2) };
    expect(conversationKey("chan", reply, false, "thread")).toBe(
      `chan/${"9".repeat(64)}`,
    );
    expect(conversationKey("chan", EVENT, false, "thread")).toBe(
      `chan/${EVENT.id}`,
    );
    expect(conversationKey("chan", reply, false, "channel")).toBe("chan");
    expect(conversationKey("chan", reply, true, "thread")).toBe("chan");
  });

  it("defaults to an agent with Buzz access, thread sessions and a ~/.buzz workspace", () => {
    expect(meshAgentConfig({})).toMatchObject({
      mode: "agent",
      buzz: true,
      scope: "thread",
      workspace: "~/.buzz",
    });
    expect(meshAgentConfig({ workspace: "relative" }).workspace).toBe(
      "~/.buzz",
    );
    expect(meshAgentConfig({ buzz: false }).buzz).toBe(false);
    expect(meshAgentConfig({ mode: "chat" }).mode).toBe("chat");
    expect(meshAgentConfig({ preset: "nope" }).preset).toBeUndefined();
  });

  it("gives Buzz access the shared Buzz prompt and other modes only their own", () => {
    const tools = instructions(meshAgentConfig({ prompt: "be brief" }));
    expect(tools).toContain("## Posting Conventions");
    expect(tools).toContain(
      "<agent-instructions>\nbe brief\n</agent-instructions>",
    );
    expect(
      instructions(meshAgentConfig({ prompt: "be brief", buzz: false })),
    ).toBe("be brief");
  });

  it("keeps the base path when the endpoint has none", () => {
    const env = gooseEnv(
      { baseUrl: "http://127.0.0.1:9/", model: "m", lease: "l" },
      "/r",
    );
    expect(env.OPENAI_BASE_PATH).toBe("chat/completions");
    expect(env.GOOSE_DISABLE_KEYRING).toBe("true");
    expect(JSON.parse(String(env.EXTENSIONS))).toMatchObject({
      extensionmanager: { enabled: false },
      summon: { enabled: false },
    });
  });
});

describe("Mesh agent Buzz tools", () => {
  const delivery = (publish = vi.fn(async (event: object) => event)) =>
    ({
      agent: {
        pubkey: AGENT,
        owner: OWNER,
        publish,
        query: vi.fn(async () => []),
      },
      signal: new AbortController().signal,
    }) as unknown as Delivery<MeshAgentConfig>;
  const spawn = vi.fn();

  it("lists the same Buzz tools as Codex and Claude Code", async () => {
    const tools = turnTools(delivery(), { spawn }, "/w", { channel: "chan" });
    const reply = (await tools.serve({ id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };
    expect(reply.result.tools.map((tool) => tool.name).sort()).toEqual(
      TOOLS.map((tool) => tool.name).sort(),
    );
  });

  it("ignores notifications", async () => {
    const tools = turnTools(delivery(), { spawn }, "/w", { channel: "chan" });
    expect(
      await tools.serve({ method: "notifications/initialized" }),
    ).toBeUndefined();
  });

  it("posts with send as the agent and ends the turn on final", async () => {
    const publish = vi.fn(async (event: object) => ({ ...event, id: "e1" }));
    const tools = turnTools(delivery(publish), { spawn }, "/w", {
      channel: "chan",
      root: "r".repeat(64),
    });
    await tools.serve({
      id: 3,
      method: "tools/call",
      params: {
        name: "send",
        arguments: { text: "done", audience: "everyone", final: true },
      },
    });
    expect(publish).toHaveBeenCalled();
    expect(tools.sent()).toBe(true);
    expect(tools.finished()).toBe(true);
  });
});

describe("Mesh recovery contracts", () => {
  it("keeps shared startup alive when another conversation still needs it", async () => {
    const { runtime, delivery, seen, publish } = setup();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    seen.beforeRequest = async (method) => {
      if (method === "initialize") {
        started();
        await gate;
      }
    };
    const controller = new AbortController();
    const first = runtime.run({ ...delivery(), signal: controller.signal });
    try {
      await entered;
      const second = runtime.run(
        delivery({ id: "d".repeat(64), created_at: 2 }),
      );
      // Both turns have crossed preparation/workspace before aborting the first.
      await vi.waitFor(() =>
        expect(
          (
            runtime as unknown as { starters: Map<string, number> }
          ).starters.get(AGENT),
        ).toBe(2),
      );
      controller.abort();
      await first;
      release();
      await second;
      expect(seen.agents).toBe(1);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      release();
      runtime.dispose();
    }
  });

  it.each(["abort", "dispose"])(
    "does not resurrect shared startup after both waiters %s",
    async (action) => {
      const { runtime, delivery, seen, publish } = setup();
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      seen.beforeRequest = async (method) => {
        if (method === "initialize") {
          started();
          await new Promise<void>(() => {});
        }
      };
      const a = new AbortController();
      const b = new AbortController();
      const first = runtime.run({ ...delivery(), signal: a.signal });
      try {
        await entered;
        const second = runtime.run({
          ...delivery({ id: "d".repeat(64) }),
          signal: b.signal,
        });
        await vi.waitFor(() =>
          expect(
            (
              runtime as unknown as { starters: Map<string, number> }
            ).starters.get(AGENT),
          ).toBe(2),
        );
        if (action === "dispose") runtime.dispose();
        else {
          a.abort();
          b.abort();
        }
        await Promise.all([first, second]);
        await vi.waitFor(() => expect(seen.kills).toBe(1));
        expect(seen.agents).toBe(1);
        delete seen.beforeRequest;
        await runtime.run(delivery({ created_at: 2 }));
        expect(seen.agents).toBe(action === "dispose" ? 1 : 2);
        if (action === "abort") expect(publish).toHaveBeenCalledTimes(1);
      } finally {
        runtime.dispose();
      }
    },
  );

  it("retires an unresponsive initialize without waiting for its response", async () => {
    const { runtime, delivery, seen, publish } = setup();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    seen.beforeRequest = async (method) => {
      if (method === "initialize") {
        started();
        await new Promise<void>(() => {});
      }
    };
    const controller = new AbortController();
    const turn = runtime.run({ ...delivery(), signal: controller.signal });
    try {
      await entered;
      controller.abort();
      await turn;
      expect(publish).not.toHaveBeenCalled();
      delete seen.beforeRequest;
      await runtime.run(delivery({ created_at: 2 }));
      expect(seen.agents).toBe(2);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      runtime.dispose();
    }
  });

  it("does not prompt after cancellation during session creation and recovers", async () => {
    const { runtime, delivery, seen, publish } = setup();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    seen.beforeRequest = async (method) => {
      if (method === "session/new") {
        started();
        await gate;
      }
    };
    const controller = new AbortController();
    const turn = runtime.run({ ...delivery(), signal: controller.signal });
    try {
      await entered;
      controller.abort();
      await turn;
      expect(prompts(seen)).toHaveLength(0);
      expect(publish).not.toHaveBeenCalled();
      release();
      delete seen.beforeRequest;
      await runtime.run(delivery({ created_at: 2 }));
      expect(prompts(seen)).toHaveLength(1);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      release();
      runtime.dispose();
    }
  });

  it("routes Buzz-access MCP send directly in a DM", async () => {
    const { runtime, delivery, seen, publish } = setup(
      { dm: () => true },
      OWNER,
      { mode: "agent" },
    );
    seen.updates = [null];
    seen.beforeRequest = async (method) => {
      if (method !== "session/prompt") return;
      seen.relay?.({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "send",
          arguments: { text: "DM answer", audience: "everyone" },
        },
      });
      await vi.waitFor(() =>
        expect(seen.bridgeOut.some((line) => JSON.parse(line).id === 42)).toBe(
          true,
        ),
      );
    };
    try {
      await runtime.run(delivery());
      expect(publish).toHaveBeenCalledTimes(1);
      const posted = publish.mock.calls[0]?.[0] as {
        content: string;
        tags: string[][];
      };
      expect(posted.content).toBe("DM answer");
      expect(posted.tags).toContainEqual(["h", "chan"]);
      expect(posted.tags.some((tag) => tag[0] === "e")).toBe(false);
    } finally {
      runtime.dispose();
    }
  });

  it.each(["chat", "agent"])(
    "%s posts directly in DMs without thread tags",
    async (mode) => {
      const { runtime, delivery, publish } = setup({ dm: () => true }, OWNER, {
        mode,
        buzz: false,
      });
      try {
        await runtime.run(delivery());
        expect(publish.mock.calls[0]?.[0]).toMatchObject({
          tags: [
            ["h", "chan"],
            ["p", OWNER],
          ],
        });
      } finally {
        runtime.dispose();
      }
    },
  );

  it.each(["chat", "agent"])(
    "%s aborts held history and the next turn recovers",
    async (mode) => {
      const { runtime, delivery, query, seen, deps, publish } = setup(
        {},
        OWNER,
        { mode, buzz: false },
      );
      let release!: (value: object[]) => void;
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      query.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const controller = new AbortController();
      const turn = runtime.run({
        ...delivery(inThread("d".repeat(64), 2)),
        signal: controller.signal,
      });
      try {
        await reading;
        controller.abort();
        await turn;
        expect(prompts(seen)).toHaveLength(0);
        expect(deps.chat).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        release([]);
        await runtime.run(delivery(inThread("e".repeat(64), 3)));
        expect(publish).toHaveBeenCalledTimes(1);
      } finally {
        release([]);
        runtime.dispose();
      }
    },
  );

  it("serves memory set/get/overwrite through MCP", async () => {
    let entries: { slug: string; body: string; createdAt: number }[] = [];
    const remember = vi.fn(
      async (slug: string, body: string, after: number) => {
        entries = [{ slug, body, createdAt: after + 1 }];
        return EVENT as never;
      },
    );
    const base = setup();
    const tools = turnTools(
      { ...base.delivery(), agent: { ...base.delivery().agent, remember } },
      { spawn: base.deps.spawn, memories: async () => entries },
      "/w",
      { channel: "chan" },
    );
    const call = (name: string, args: object) =>
      tools.serve({
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
    await call("mem_set", { slug: "note", text: "first" });
    expect(JSON.stringify(await call("mem_get", { slug: "note" }))).toContain(
      "first",
    );
    await call("mem_set", { slug: "note", text: "second" });
    expect(remember.mock.calls[1]?.[2]).toBe(1);
    expect(JSON.stringify(await call("mem_get", { slug: "note" }))).toContain(
      "second",
    );
  });
});
