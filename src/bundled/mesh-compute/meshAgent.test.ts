import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import {
  gooseEnv,
  instructions,
  type MeshAgentConfig,
  type MeshAgentDeps,
  meshAgentConfig,
  runMeshAgent,
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
};
function fakeSpawn(reply: string, seen: Seen) {
  return vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    if (id === "workspace" || id === "bridge") {
      if (id === "workspace")
        queueMicrotask(() =>
          options.onStdout?.(
            `/home/u/${String(options.cwd).replace("~/", "")}\n`,
          ),
        );
      return {
        exited: Promise.resolve(id === "workspace" ? 0 : null),
        end: async () => {},
        kill: async () => {},
        write: async () => {},
      };
    }
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
        if (method === "session/new") out({ id, result: { sessionId: "s1" } });
        if (method === "session/prompt") {
          out({
            method: "session/update",
            params: {
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

function setup(
  over: Partial<MeshAgentDeps> = {},
  from = OWNER,
  config: object = { prompt: "be brief", reply: "direct" },
) {
  const seen: Seen = { calls: [] };
  const publish = vi.fn(async (event: object) => event);
  const deps: MeshAgentDeps = {
    spawn: fakeSpawn("hi from mesh", seen),
    origin: () => "https://community.example",
    prepare: async () => ({
      baseUrl: "http://127.0.0.1:19337/v1",
      model: "mesh",
      lease: "L1",
    }),
    current: async () => true,
    ...over,
  };
  const delivery = {
    trigger: { type: "mention", event: { ...EVENT, pubkey: from } },
    channelId: "chan",
    agent: { pubkey: AGENT, name: "M", owner: OWNER, publish },
    config,
    signal: new AbortController().signal,
  } as unknown as Delivery<MeshAgentConfig>;
  return { deps, delivery, publish, seen };
}

describe("Mesh agent runtime", () => {
  it("publishes the helper's reply as the agent, threaded to the mention", async () => {
    const { deps, delivery, publish, seen } = setup();
    await runMeshAgent(deps, delivery);
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

  it("drops a reply whose lease went stale mid-turn", async () => {
    const { deps, delivery, publish } = setup({ current: async () => false });
    await runMeshAgent(deps, delivery);
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports unavailable shared compute instead of falling back", async () => {
    const spawn = vi.fn();
    const { deps, delivery, publish } = setup({
      spawn,
      prepare: async () => {
        throw new Error("Shared compute inference did not become ready");
      },
    });
    await runMeshAgent(deps, delivery);
    expect(spawn).not.toHaveBeenCalled();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("did not become ready"),
    });
  });

  it("ignores anyone but its owner", async () => {
    const { deps, delivery, publish } = setup({}, "d".repeat(64));
    await runMeshAgent(deps, delivery);
    expect(publish).not.toHaveBeenCalled();
  });

  it("hands goose the Buzz bridge in tools mode and posts its text if it never sends", async () => {
    const { deps, delivery, publish, seen } = setup({}, OWNER, {
      prompt: "be brief",
    });
    await runMeshAgent(deps, delivery);
    const servers = seen.calls.find((c) => c.method === "session/new")?.params
      .mcpServers as { name: string; command: string; args: string[] }[];
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "buzz", command: "nc" });
    expect(servers[0]?.args[0]).toBe("-U");
    expect(servers[0]?.args[1]).toMatch(
      /^\/tmp\/buzz-mesh-[0-9a-f]{16}\.sock$/,
    );
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "hi from mesh",
    });
  });

  it("defaults to tools mode and a ~/.buzz workspace", () => {
    expect(meshAgentConfig({})).toMatchObject({
      reply: "tools",
      workspace: "~/.buzz",
    });
    expect(meshAgentConfig({ workspace: "relative" }).workspace).toBe(
      "~/.buzz",
    );
    expect(meshAgentConfig({ reply: "direct" }).reply).toBe("direct");
  });

  it("gives tools mode the shared Buzz prompt and direct mode only its own", () => {
    const tools = instructions(meshAgentConfig({ prompt: "be brief" }));
    expect(tools).toContain("## Posting Conventions");
    expect(tools).toContain(
      "<agent-instructions>\nbe brief\n</agent-instructions>",
    );
    expect(
      instructions(meshAgentConfig({ prompt: "be brief", reply: "direct" })),
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

  it("lists only send and read", async () => {
    const tools = turnTools(delivery(), { spawn }, "/w", { channel: "chan" });
    const reply = (await tools.serve({ id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };
    expect(reply.result.tools.map((tool) => tool.name).sort()).toEqual([
      "read",
      "send",
    ]);
  });

  it("refuses other Buzz tools and ignores notifications", async () => {
    const tools = turnTools(delivery(), { spawn }, "/w", { channel: "chan" });
    expect(
      await tools.serve({ method: "notifications/initialized" }),
    ).toBeUndefined();
    const reply = (await tools.serve({
      id: 2,
      method: "tools/call",
      params: { name: "dm", arguments: { to: ["x"] } },
    })) as { result: { isError: boolean } };
    expect(reply.result.isError).toBe(true);
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
