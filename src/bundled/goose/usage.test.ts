import { afterEach, expect, it, vi } from "vitest";
import type { EventData } from "../../features/relay/events";
import { turnPrompt } from "../claude-code/prompt";
import { REQUEST_TIMEOUT_MS } from "./goose";
import { type FakeSession, fakeSpawn } from "./goose-testing";
import { GooseHistory } from "./transcript";
import { readUsage, sessionUsage } from "./usage";

const agent = "c".repeat(64);
const other = "d".repeat(64);
const start = 1_800_000_000;
const mention = {
  id: "1".repeat(64),
  pubkey: "a".repeat(64),
  kind: 9,
  created_at: start,
  content: "@Grok fix the build",
  tags: [["h", "chan"]],
  sig: "",
} as EventData;
const ask = (pubkey = agent) =>
  turnPrompt({
    agent: pubkey,
    event: mention,
    channel: { id: "chan", name: "general" },
    scope: "thread",
    context: [],
    total: 1,
    label: "@mention",
    name: () => undefined,
  });
const user = (text: string, created = start, userVisible = true) => ({
  role: "user",
  created,
  content: [{ type: "text", text }],
  metadata: { userVisible },
});
const reply = (
  created: number,
  usage: Record<string, unknown>,
  requestedModel = "databricks-claude-sonnet-5-5",
) => ({
  role: "assistant",
  created,
  content: [{ type: "text", text: "Done." }],
  metadata: {
    userVisible: true,
    inference: { requestedModel, resolvedModel: `system.ai.${requestedModel}` },
    usage,
  },
});
// goose's input counts the cached prompt tokens too.
const tokens = (input: number, read: number, write: number, cost?: number) => ({
  inputTokens: input + read + write,
  outputTokens: 10,
  cacheReadTokens: read,
  cacheWriteTokens: write,
  ...(cost === undefined ? {} : { cost, costSource: "estimated" }),
});

it("observes each reply's tokens and goose's price", () => {
  const session = sessionUsage("s", [
    user(ask()),
    user("<turn-context>…</turn-context>", start, false),
    { ...reply(start + 1, tokens(4, 0, 100, 0.06)), id: "r1" },
    // An unpriced reply is left to be priced from its tokens.
    reply(start + 3600, tokens(1, 50, 0)),
    // Without the cache counts, the uncached input is unknown.
    reply(start + 3601, { inputTokens: 9, outputTokens: 3 }),
  ]);
  expect(session).toEqual({
    id: "s",
    channelId: "chan",
    root: mention.id,
    title: "@Grok fix the build",
    startedAt: start * 1000,
    lastAt: (start + 3601) * 1000,
    gaps: [],
    observations: [
      {
        requestId: "r1",
        at: (start + 1) * 1000,
        model: "databricks-claude-sonnet-5-5",
        tokens: { input: 4, output: 10, cacheRead: 0, cacheWrite: 100 },
        cost: { usd: 0.06, source: "estimated" },
      },
      {
        at: (start + 3600) * 1000,
        model: "databricks-claude-sonnet-5-5",
        tokens: { input: 1, output: 10, cacheRead: 50, cacheWrite: 0 },
      },
      {
        at: (start + 3601) * 1000,
        model: "databricks-claude-sonnet-5-5",
        tokens: { output: 3 },
      },
    ],
  });
  // Not a Buzz prompt: the person's own goose session.
  expect(sessionUsage("s", [user("hi"), reply(start, tokens(1, 0, 0))])).toBe(
    undefined,
  );
});

it("reads the agent's sessions in its workspace through goose, every page", async () => {
  const saved = (
    sessionId: string,
    conversation: Record<string, unknown>[],
    updatedAt = "2027-01-15T08:00:00Z",
  ): FakeSession => ({
    sessionId,
    title: `Grok · #general · ${sessionId}`,
    cwd: "/home/test/.buzz",
    updatedAt,
    conversation,
  });
  const work = reply(start + 1, tokens(1, 2, 3, 0.5));
  const history = new GooseHistory(
    fakeSpawn({
      home: "/home/test",
      page: 2,
      history: [
        // Another agent's session that mentions this one.
        saved("theirs", [user(ask(other)), user(`Ask ${agent}`), work]),
        saved("old", [user(ask()), work], "2026-01-01T00:00:00Z"),
        // A session of the user's own.
        saved("own", [user("Tidy my notes"), work]),
        saved("mine", [user(ask()), work]),
      ],
    }).spawn,
  );
  const sessions = await readUsage(
    history,
    agent,
    "~/.buzz",
    Date.parse("2026-06-01T00:00:00Z"),
    new AbortController().signal,
  );
  expect(sessions.map((session) => session.id)).toEqual(["mine"]);
  expect(sessions[0]?.observations[0]).toMatchObject({
    tokens: { input: 1, cacheRead: 2, cacheWrite: 3 },
    cost: { usd: 0.5 },
  });
});

it("stops goose when a read is cancelled while an export is pending", async () => {
  const export_ = "_goose/unstable/session/export";
  const goose = fakeSpawn({
    home: "/home/test",
    history: [
      {
        sessionId: "mine",
        title: "Grok · #general · mine",
        cwd: "/home/test/.buzz",
        updatedAt: "2027-01-15T08:00:00Z",
        conversation: [user(ask()), reply(start + 1, tokens(1, 2, 3, 0.5))],
      },
    ],
    silent: [export_],
  });
  const controller = new AbortController();
  const reading = readUsage(
    new GooseHistory(goose.spawn),
    agent,
    "~/.buzz",
    Date.parse("2026-06-01T00:00:00Z"),
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(
      goose.geese[0]?.received.some((message) => message.method === export_),
    ).toBe(true),
  );
  controller.abort(new Error("left the page"));
  await expect(reading).rejects.toThrow("left the page");
  expect(goose.geese[0]?.killed).toBe(true);
});

afterEach(() => {
  vi.useRealTimers();
});

it.each(["session/list", "_goose/unstable/session/export"])(
  "stops a goose that does not answer %s, and fails the read",
  async (method) => {
    vi.useFakeTimers();
    const goose = fakeSpawn({
      home: "/home/test",
      history: [
        {
          sessionId: "mine",
          title: "Grok · #general · mine",
          cwd: "/home/test/.buzz",
          updatedAt: "2027-01-15T08:00:00Z",
          conversation: [user(ask()), reply(start + 1, tokens(1, 2, 3, 0.5))],
        },
      ],
      silent: [method],
    });
    const reading = readUsage(
      new GooseHistory(goose.spawn),
      agent,
      "~/.buzz",
      Date.parse("2026-06-01T00:00:00Z"),
      new AbortController().signal,
    );
    const failed = expect(reading).rejects.toThrow(
      `goose did not answer ${method} in 60s`,
    );
    await vi.waitFor(() =>
      expect(
        goose.geese[0]?.received.some((message) => message.method === method),
      ).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    expect(goose.geese[0]?.killed).toBe(true);
  },
);
