import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import type { Wire } from "./rpc";
import { codexTurns, readTranscript } from "./transcript";

const root = "c".repeat(64);
const conversation = { channelId: "channel", root };
const input = `<context>\n{"channel_id":"channel"}\n</context>\n<buzz-event>\n{"id":"e"}\nRequest: "fix the \\u003ctests\\u003e"\n</buzz-event>`;
const turn = (patch: Record<string, unknown> = {}) => ({
  id: "turn-1",
  status: "completed",
  error: null,
  startedAt: 100,
  completedAt: 160,
  items: [
    {
      type: "userMessage",
      id: "u1",
      content: [{ type: "text", text: input }],
    },
    { type: "reasoning", id: "r1", summary: ["Looking at tests"] },
    {
      type: "commandExecution",
      id: "c1",
      command: "pnpm test",
      aggregatedOutput: "1 failed",
      status: "failed",
      durationMs: 2000,
    },
    {
      type: "userMessage",
      id: "u2",
      content: [
        {
          type: "text",
          text: '<new-message-arrived-while-you-were-working>\n{}\nRequest: "also lint"\n</new-message-arrived-while-you-were-working>',
        },
      ],
    },
    {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [{ path: "a.ts", kind: "update", diff: "-a\n+b" }],
    },
    {
      type: "dynamicToolCall",
      id: "d1",
      namespace: "buzz",
      tool: "send",
      arguments: { text: "Done" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "sent" }],
      success: true,
    },
    { type: "agentMessage", id: "a1", text: "Fixed." },
    { type: "contextCompaction", id: "x1" },
  ],
  ...patch,
});

it("shows a Codex turn's request, steering, tools and reply in the shared transcript model", () => {
  const [mapped] = codexTurns([turn()], conversation);
  expect(mapped).toMatchObject({
    turnId: "turn-1",
    channelId: "channel",
    threadRootId: root,
    startedAt: 100_000,
    endedAt: 160_000,
  });
  expect(mapped?.items).toEqual([
    expect.objectContaining({
      type: "prompt",
      text: "fix the <tests>",
      steer: false,
      sections: [
        expect.objectContaining({ tag: "context" }),
        expect.objectContaining({ tag: "buzz-event" }),
      ],
    }),
    expect.objectContaining({ type: "thought", text: "Looking at tests" }),
    expect.objectContaining({
      type: "tool",
      title: "pnpm test",
      kind: "execute",
      status: "failed",
      output: "1 failed",
      completedAt: 102_000,
    }),
    expect.objectContaining({ type: "prompt", text: "also lint", steer: true }),
    expect.objectContaining({
      type: "tool",
      kind: "edit",
      paths: ["a.ts"],
      output: "-a\n+b",
    }),
    expect.objectContaining({
      type: "tool",
      title: "buzz.send",
      status: "completed",
      output: "sent",
    }),
    expect.objectContaining({ type: "message", text: "Fixed." }),
  ]);
  const [channelTurn] = codexTurns(
    [turn({ status: "interrupted", completedAt: null, items: [] })],
    { channelId: "channel" },
  );
  expect(channelTurn).toMatchObject({
    threadRootId: null,
    stopReason: "interrupted",
  });
  expect(channelTurn).not.toHaveProperty("endedAt");
});

/** An app-server answering `thread/turns/list` as the test says. */
function server(list: (params: Record<string, unknown>) => Wire) {
  const sent: Wire[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    return {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        sent.push(wire);
        if (wire.id == null) return;
        const reply =
          wire.method === "thread/turns/list"
            ? list(wire.params as Record<string, unknown>)
            : { result: {} };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, ...reply })}\n`);
      },
      end: async () => exit(0),
      kill: async () => exit(1),
      exited,
    };
  });
  return { spawn, sent };
}

it("reads the latest turns oldest first and closes its app-server", async () => {
  const { spawn, sent } = server(() => ({
    result: {
      data: [
        turn({ id: "turn-2", status: "inProgress", completedAt: null }),
        turn(),
      ],
      nextCursor: "earlier",
    },
  }));
  const read = await readTranscript(
    spawn,
    "thread-1",
    conversation,
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith("app-server", expect.anything());
  expect(sent.find((w) => w.method === "thread/turns/list")?.params).toEqual({
    threadId: "thread-1",
    limit: 20,
    sortDirection: "desc",
    itemsView: "full",
  });
  expect(read?.turns.map((t) => t.turnId)).toEqual(["turn-1", "turn-2"]);
  expect(read).toMatchObject({ more: true, working: true });
});

it("treats a thread Codex no longer has as missing, and other failures as errors", async () => {
  const signal = new AbortController().signal;
  const gone = server(() => ({
    error: { code: -32600, message: "thread not loaded: thread-1" },
  }));
  await expect(
    readTranscript(gone.spawn, "thread-1", conversation, signal),
  ).resolves.toBeUndefined();
  const broken = server(() => ({
    error: { code: -32603, message: "database is locked" },
  }));
  await expect(
    readTranscript(broken.spawn, "thread-1", conversation, signal),
  ).rejects.toThrow("database is locked");
});
