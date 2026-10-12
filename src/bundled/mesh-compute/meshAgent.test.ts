import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import {
  helperEnv,
  type MeshAgentConfig,
  type MeshAgentDeps,
  runMeshAgent,
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
function fakeSpawn(reply: string, seen: { env?: HostProcessOptions["env"] }) {
  return vi.fn(async (_id: string, options: HostProcessOptions = {}) => {
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
        const { id, method } = JSON.parse(line);
        if (method === "initialize") out({ id, result: {} });
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

function setup(over: Partial<MeshAgentDeps> = {}, from = OWNER) {
  const seen: { env?: HostProcessOptions["env"] } = {};
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
    config: { prompt: "be brief" },
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
      BUZZ_AGENT_PROVIDER: "relay-mesh",
      OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:19337/v1",
      BUZZ_AGENT_SYSTEM_PROMPT: "be brief",
      OPENAI_API_KEY: null,
      BUZZ_PRIVATE_KEY: null,
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

  it("uses the default prompt for a blank one", () => {
    const env = helperEnv({ baseUrl: "u", model: "m", lease: "l" }, "  ");
    expect(env.BUZZ_AGENT_SYSTEM_PROMPT).toMatch(/no tools/);
  });
});
