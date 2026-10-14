import { describe, expect, it, vi } from "vitest";
import { historyTitle, type MeshAgentDeps } from "./meshAgent";
import { MeshHistory, gooseTurns, historyPlace } from "./meshTranscript";

const agent = "b".repeat(64);
const place = { channelId: "channel", root: "thread" };
const title = historyTitle(agent, place);
const row = { ...place, sessionId: "saved", title, at: 0 };
const text = (text: string) => ({ type: "text", text });
const conversation = [
  { role: "user", created: 1, content: [text("question")] },
  {
    role: "user",
    created: 1,
    content: [text("hidden context")],
    metadata: { userVisible: false },
  },
  {
    role: "assistant",
    created: 2,
    content: [
      {
        type: "toolRequest",
        id: "call",
        toolCall: {
          status: "success",
          value: { name: "developer__shell", arguments: { command: "pwd" } },
        },
      },
    ],
  },
  {
    role: "user",
    created: 3,
    content: [
      {
        type: "toolResponse",
        id: "call",
        toolResult: {
          status: "success",
          value: { content: [text("/workspace")] },
        },
      },
    ],
  },
  {
    role: "user",
    created: 4,
    content: [
      text(
        "<new-message-arrived-while-you-were-working>\nnew instruction\n</new-message-arrived-while-you-were-working>",
      ),
    ],
  },
  { role: "assistant", created: 5, content: [text("answer")] },
];

function fixture(
  result: (method: string, params: Record<string, unknown>) => unknown,
) {
  const calls: string[] = [];
  const kill = vi.fn(async () => {});
  const spawn: MeshAgentDeps["spawn"] = vi.fn(async (_id, options = {}) => {
    if (_id === "workspace") {
      options.onStdout?.("/isolated/state\n");
      return {
        write: async () => {},
        end: async () => {},
        kill,
        exited: Promise.resolve(0),
      };
    }
    return {
      kill,
      end: async () => {},
      exited: new Promise<number | null>(() => {}),
      write: async (line: string) => {
        const { id, method, params } = JSON.parse(line);
        calls.push(method);
        const value = result(method, params);
        if (value !== undefined)
          options.onStdout?.(`${JSON.stringify({ id, result: value })}\n`);
      },
    };
  });
  return { history: new MeshHistory(spawn), calls, kill, spawn };
}

describe("Mesh transcripts", () => {
  it("projects tools, results and steering without showing hidden context", () => {
    const turns = gooseTurns(conversation, row, true);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.endedAt).toBeUndefined();
    expect(turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          status: "completed",
          output: "/workspace",
        }),
        expect.objectContaining({
          type: "prompt",
          text: "new instruction",
          steer: true,
        }),
        expect.objectContaining({ type: "message", text: "answer" }),
      ]),
    );
    expect(JSON.stringify(turns)).not.toContain("hidden context");
  });

  it("uses stable agent identities, rejects malformed and unrelated titles", () => {
    expect(historyPlace(title, agent)).toEqual(place);
    for (const value of [
      title,
      "Buzz Mesh {}",
      "Buzz Mesh null",
      "Buzz Mesh bad",
      "legacy session",
    ])
      expect(historyPlace(value, "other-agent")).toBeUndefined();
  });

  it("reads paginated agent history without inference or session creation", async () => {
    const f = fixture((method, params) =>
      method === "initialize"
        ? {}
        : {
            sessions: params.cursor
              ? [
                  {
                    sessionId: "saved",
                    title,
                    updatedAt: "2026-10-14T00:00:00Z",
                  },
                ]
              : [{ sessionId: "other", title: historyTitle("other", place) }],
            ...(params.cursor ? {} : { nextCursor: "page2" }),
          },
    );
    const rows = await f.history.recent(
      agent,
      "/workspace",
      new AbortController().signal,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...place, sessionId: "saved", title });
    expect(f.calls).toEqual(["initialize", "session/list", "session/list"]);
    expect(f.kill).toHaveBeenCalledTimes(1);
    expect(f.spawn).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        env: expect.objectContaining({
          GOOSE_PATH_ROOT: "/isolated/state",
          BUZZ_PRIVATE_KEY: null,
        }),
      }),
    );
  });

  it("exports saved transcripts and always stops its reader", async () => {
    const f = fixture((method) =>
      method === "initialize"
        ? {}
        : { data: JSON.stringify({ name: title, conversation }) },
    );
    const transcript = await f.history.transcript(
      agent,
      "/workspace",
      row,
      new AbortController().signal,
    );
    expect(transcript.turns).toHaveLength(1);
    expect(f.calls).toEqual(["initialize", "_goose/unstable/session/export"]);
    expect(f.kill).toHaveBeenCalledTimes(1);
  });

  it("refuses an exported session from a different agent", async () => {
    const f = fixture((method) =>
      method === "initialize"
        ? {}
        : {
            data: JSON.stringify({
              name: historyTitle("other", place),
              conversation,
            }),
          },
    );
    await expect(
      f.history.transcript(
        agent,
        "/workspace",
        row,
        new AbortController().signal,
      ),
    ).rejects.toThrow("does not belong");
    expect(f.kill).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending read and cleans up the owned process", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture((method) => {
      if (method === "initialize") return {};
      entered();
      return undefined;
    });
    const controller = new AbortController();
    const reading = f.history.recent(agent, "/workspace", controller.signal);
    const rejected = expect(reading).rejects.toThrow("cancelled");
    await started;
    controller.abort();
    await rejected;
    expect(f.kill).toHaveBeenCalled();
  });
});
