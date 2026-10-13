import { TOOLS } from "../../buzz-mcp/tools";
import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import {
  conversationKey,
  gooseEnv,
  instructions,
  type MeshAgentConfig,
  type MeshAgentDeps,
  MeshAgentRuntime,
  meshAgentConfig,
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
  /** Sends a line from goose's relay into the plugin's bridge end. */
  relay?: (message: object) => void;
  bridgeOut: string[];
  failLoad?: boolean;
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
        kill: async () => {},
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
      kill: async () => resolveExit(null),
      write: async (line: string) => {
        const { id, method, params } = JSON.parse(line);
        seen.calls.push({ method, params });
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
        if (method === "session/prompt") {
          out({
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: reply },
              },
            },
          });
          out({ id, result: { stopReason: "end_turn" } });
        }
      },
    };
  });
}

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

function setup(
  over: Partial<MeshAgentDeps> = {},
  from = OWNER,
  config: object = { prompt: "be brief", mode: "workspace" },
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
    storage: memoryStorage(),
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

  it("uses one session for the whole channel in channel scope", async () => {
    const { delivery, seen, runtime } = setup({}, OWNER, {
      mode: "workspace",
      scope: "channel",
    });
    await runtime.run(delivery());
    await runtime.run(delivery({ id: "e".repeat(64) }));
    expect(new Set(prompts(seen).map((p) => p.session)).size).toBe(1);
  });

  it("resumes the conversation's saved session after a restart, ignoring replayed history", async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    await first.runtime.run(first.delivery());
    first.runtime.dispose();
    const second = setup({ storage });
    await second.runtime.run(second.delivery());
    expect(
      second.seen.calls.find((c) => c.method === "session/load")?.params,
    ).toEqual({
      sessionId: "s1",
      cwd: "/home/u/.buzz",
      mcpServers: [],
    });
    expect(second.seen.calls.some((c) => c.method === "session/new")).toBe(
      false,
    );
    expect(second.publish.mock.calls[0]?.[0]).toMatchObject({
      content: "hi from mesh",
    });
  });

  it("starts fresh when the saved session can't be loaded", async () => {
    const storage = memoryStorage();
    storage.setItem(
      `buzz.mesh-agent.session:${AGENT}\nworkspace\nchan/${EVENT.id}`,
      JSON.stringify({ id: "gone", seen: 0 }),
    );
    const { delivery, seen, runtime, publish } = setup({ storage });
    seen.failLoad = true;
    await runtime.run(delivery());
    expect(seen.calls.some((c) => c.method === "session/new")).toBe(true);
    expect(publish).toHaveBeenCalled();
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

  it("keeps the Buzz bridge for the session in full mode, answering discovery but refusing calls between turns", async () => {
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

  it("defaults to full mode, thread sessions and a ~/.buzz workspace, and migrates direct replies", () => {
    expect(meshAgentConfig({})).toMatchObject({
      mode: "full",
      scope: "thread",
      workspace: "~/.buzz",
    });
    expect(meshAgentConfig({ workspace: "relative" }).workspace).toBe(
      "~/.buzz",
    );
    expect(meshAgentConfig({ reply: "direct" }).mode).toBe("workspace");
    expect(meshAgentConfig({ mode: "chat" }).mode).toBe("chat");
    expect(meshAgentConfig({ preset: "nope" }).preset).toBeUndefined();
  });

  it("gives full mode the shared Buzz prompt and other modes only their own", () => {
    const tools = instructions(meshAgentConfig({ prompt: "be brief" }));
    expect(tools).toContain("## Posting Conventions");
    expect(tools).toContain(
      "<agent-instructions>\nbe brief\n</agent-instructions>",
    );
    expect(
      instructions(meshAgentConfig({ prompt: "be brief", mode: "workspace" })),
    ).toBe("be brief");
  });

  it("keeps the base path when the endpoint has none", () => {
    const env = gooseEnv(
      { baseUrl: "http://127.0.0.1:9/", model: "m", lease: "l" },
      "/r",
    );
    expect(env.OPENAI_BASE_PATH).toBe("chat/completions");
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
