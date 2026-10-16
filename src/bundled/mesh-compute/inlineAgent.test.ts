import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TOOLS } from "../../buzz-mcp/tools";
import { InlineAgent, INLINE_TOOLS, type InlineTurn } from "./inlineAgent";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage?: (frame: unknown) => void;
  },
}));
function input() {
  const publish = vi.fn(async (_event: unknown) => ({ id: "e".repeat(64) }));
  const abort = new AbortController();
  const delivery = {
    agent: {
      pubkey: "a".repeat(64),
      owner: "b".repeat(64),
      publish,
      query: vi.fn(async () => []),
      remember: vi.fn(),
    },
    signal: abort.signal,
    current: () => true,
    config: { mode: "agent" },
  } as unknown as InlineTurn["delivery"];
  const turn: InlineTurn = {
    delivery,
    inference: { baseUrl: "unused", lease: "lease", model: "model" },
    cwd: "/tmp",
    context: { channel: "channel", root: "c".repeat(64) },
    sessionKey: "test",
    system: "system",
    prompt: "hello",
  };
  const current = vi.fn(async () => true);
  const runtime = new InlineAgent({ spawn: vi.fn(), current });
  return { runtime, turn, publish, abort, current };
}
it("advertises the full shared Buzz catalog without a final-turn flag", () => {
  expect(INLINE_TOOLS.map((t) => t.name)).toEqual(
    TOOLS.map((t) => `buzz_${t.name}`),
  );
  expect(INLINE_TOOLS[0]?.inputSchema.properties).not.toHaveProperty("final");
});
it("reuses the real Buzz send handler under the captured agent and returns final prose", async () => {
  const { runtime, turn, publish } = input();
  let resolve!: () => void;
  const response = new Promise<void>((r) => {
    resolve = r;
  });
  ipc.invoke.mockImplementation(async (command, args) => {
    if (command === "mesh_compute_agent_run") {
      expect(args.request.messages[0].metadata).toEqual({
        userVisible: true,
        agentVisible: true,
      });
      const run = args.request.id;
      args.events.onmessage({
        type: "tool",
        run,
        id: 1,
        call: {
          name: "buzz_send",
          arguments: { text: "update", audience: "everyone" },
        },
      });
      await response;
      args.events.onmessage({
        type: "message",
        run,
        message: {
          role: "assistant",
          created: 1,
          content: [{ type: "text", text: "Final answer" }],
        },
      });
      return "Final answer";
    }
    if (command === "mesh_compute_agent_result") {
      expect(args.result.isError).not.toBe(true);
      resolve();
    }
  });
  expect(await runtime.run(turn)).toEqual({ text: "Final answer" });
  expect(publish).toHaveBeenCalledOnce();
  expect(publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9,
    content: "update",
  });
  expect(
    await runtime.recent(
      turn.delivery.agent.pubkey,
      "/tmp",
      turn.delivery.signal,
    ),
  ).toHaveLength(1);
});
it("refuses tool publication after lease revocation and rejects unavailable tools", async () => {
  const { runtime, turn, publish, current } = input();
  let resolve!: () => void;
  const response = new Promise<void>((r) => {
    resolve = r;
  });
  ipc.invoke.mockImplementation(async (command, args) => {
    if (command === "mesh_compute_agent_run") {
      current.mockResolvedValue(false);
      args.events.onmessage({
        type: "tool",
        run: args.request.id,
        id: 1,
        call: {
          name: "buzz_send",
          arguments: { text: "stale", audience: "everyone" },
        },
      });
      await response;
      return "late";
    }
    if (command === "mesh_compute_agent_result") {
      expect(args.result.isError).toBe(true);
      resolve();
    }
  });
  await expect(runtime.run(turn)).rejects.toThrow("retired");
  expect(publish).not.toHaveBeenCalled();
});
it("resends cancellation on ready if cancellation beat native registration", async () => {
  const { runtime, turn, abort, publish } = input();
  ipc.invoke.mockImplementation(async (command, args) => {
    if (command === "mesh_compute_agent_run") {
      abort.abort();
      args.events.onmessage({ type: "ready", run: args.request.id });
      throw new Error("cancelled");
    }
  });
  await expect(runtime.run(turn)).rejects.toThrow();
  expect(
    ipc.invoke.mock.calls.filter(
      ([command]) => command === "mesh_compute_agent_cancel",
    ).length,
  ).toBeGreaterThanOrEqual(2);
  expect(publish).not.toHaveBeenCalled();
});

it("always advertises Buzz tools and rejects callbacks for unknown tools", async () => {
  const { runtime, turn, publish } = input();
  let resolve!: () => void;
  const response = new Promise<void>((r) => {
    resolve = r;
  });
  ipc.invoke.mockImplementation(async (command, args) => {
    if (command === "mesh_compute_agent_run") {
      expect(args.request.tools).toEqual(INLINE_TOOLS);
      args.events.onmessage({
        type: "tool",
        run: args.request.id,
        id: 1,
        call: {
          name: "buzz_unknown",
          arguments: { text: "not permitted", audience: "everyone" },
        },
      });
      await response;
      return "Answer";
    }
    if (command === "mesh_compute_agent_result") {
      expect(args.result.isError).toBe(true);
      resolve();
    }
  });
  expect(await runtime.run(turn)).toEqual({
    text: "Answer",
  });
  expect(publish).not.toHaveBeenCalled();
});

it("returns a bounded error for large memory instead of leaving a callback pending", async () => {
  const { turn } = input();
  const runtime = new InlineAgent({
    spawn: vi.fn(),
    current: async () => true,
    memories: async () => ({
      entries: [{ slug: "core", body: "x".repeat(40_000), createdAt: 1 }],
      partial: false,
    }),
  });
  let resolve!: () => void;
  const response = new Promise<void>((r) => {
    resolve = r;
  });
  ipc.invoke.mockImplementation(async (command, args) => {
    if (command === "mesh_compute_agent_run") {
      args.events.onmessage({
        type: "tool",
        run: args.request.id,
        id: 1,
        call: { name: "buzz_mem_get", arguments: { slug: "core" } },
      });
      await response;
      return "Result was too large";
    }
    if (command === "mesh_compute_agent_result") {
      expect(args.result.isError).toBe(true);
      expect(JSON.stringify(args.result)).toContain("exceeded 32 KiB");
      expect(
        new TextEncoder().encode(JSON.stringify(args.result)).byteLength,
      ).toBeLessThan(32 * 1024);
      resolve();
    }
  });
  expect(await runtime.run(turn)).toEqual({ text: "Result was too large" });
});

it("cancels the native run if result delivery fails", async () => {
  const { runtime, turn } = input();
  let resolve!: () => void;
  const cancelled = new Promise<void>((r) => {
    resolve = r;
  });
  ipc.invoke.mockImplementation(async (command, args) => {
    if (command === "mesh_compute_agent_run") {
      args.events.onmessage({
        type: "tool",
        run: args.request.id,
        id: 1,
        call: { name: "not_available", arguments: {} },
      });
      await cancelled;
      throw new Error("native cancelled");
    }
    if (command === "mesh_compute_agent_result")
      throw new Error("IPC unavailable");
    if (command === "mesh_compute_agent_cancel") resolve();
  });
  await expect(runtime.run(turn)).rejects.toThrow("native cancelled");
});

it("keeps the native admitted catalog equal to the advertised shared tools", () => {
  const native = readFileSync(
    new URL("../../../src-tauri/src/mesh_compute/inline.rs", import.meta.url),
    "utf8",
  );
  const catalog =
    native.match(/const BUZZ_TOOLS: &[\s\S]*?= &\[([\s\S]*?)\];/)?.[1] ?? "";
  const names = [...catalog.matchAll(/"(buzz_[a-z_]+)"/g)].map(
    (match) => match[1],
  );
  expect(names.sort()).toEqual(INLINE_TOOLS.map((tool) => tool.name).sort());
});
