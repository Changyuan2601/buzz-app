import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInspector,
  ownsThread,
  threadId,
} from "../../scripts/session-debug.mjs";
import { parseLines, sessionModel } from "../../scripts/session-model.mjs";
const stamp = (n) => new Date(1700000000000 + n * 1000).toISOString();
const event = (n, type, p = {}) => ({
  type: "event_msg",
  timestamp: stamp(n),
  payload: { type, ...p },
});
const id = "a".repeat(64);
const user = (n, text) => ({
  type: "response_item",
  timestamp: stamp(n),
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  },
});
const codex = [
  {
    type: "session_meta",
    payload: {
      id: "test",
      base_instructions: { text: "base <script>no()</script>" },
      dynamic_tools: [{ name: "tool", inputSchema: { type: "object" } }],
    },
  },
  event(0, "task_started", { turn_id: "t1" }),
  {
    type: "turn_context",
    timestamp: stamp(0),
    payload: { model: "test-model" },
  },
  user(
    1,
    `<context>\n${JSON.stringify({ session_thread: id })}\n</context>\nRequest: "hello"`,
  ),
  {
    type: "token_usage_record",
    timestamp: stamp(2),
    payload: {
      turn_id: "t1",
      response_id: "r1",
      usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
    },
  },
  event(2, "token_count", {
    info: {
      total_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 50,
        output_tokens: 10,
      },
    },
  }),
  event(3, "task_complete", { turn_id: "t1", duration_ms: 2900 }),
];

test("accepts thread links, not arbitrary URLs", () => {
  assert.equal(threadId(`buzz://message?id=${id}`), id);
  assert.throws(() => threadId(`https://example.com/?id=${id}`));
  assert.throws(() => threadId("bad"));
});
test("matches user delivery context, not tool outputs or quoted history", () => {
  assert.equal(ownsThread(codex, id), true);
  assert.equal(
    ownsThread(
      [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            output: JSON.stringify(codex),
          },
        },
      ],
      id,
    ),
    false,
  );
  assert.equal(
    ownsThread(
      [user(0, `<thread-context>${JSON.stringify(codex)}</thread-context>`)],
      id,
    ),
    false,
  );
});
test("only tolerates a partial final line", () => {
  assert.equal(parseLines('{"a":1}\n{"a":', true).length, 1);
  assert.throws(() => parseLines('{bad}\n{"a":1}\n', true));
});
test("Codex exposes recorded context and counts usage only once", () => {
  const result = sessionModel([...codex, codex[4]], {
    rates: { "test-model": { input: 2, output: 10, cached: 1, written: 2 } },
  });
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].durationMs, 2900);
  assert.equal(result.turns[0].usage.input, 100);
  assert.equal(result.turns[0].requests.length, 1);
  assert.equal(result.turns[0].estimate, 0.00025);
  assert.equal(result.turns[0].cost, null);
  assert.match(result.entries[0].html, /&lt;script&gt;/);
  assert.equal(result.entries[1].label, "Recorded dynamic tool definitions");
});
test("Claude deduplicates streamed blocks and ignores tool-result turns", () => {
  const records = [
    {
      type: "user",
      uuid: "u",
      timestamp: stamp(0),
      message: { content: "hi" },
    },
    ...[1, 2].map((n) => ({
      type: "assistant",
      timestamp: stamp(n),
      message: {
        id: "m",
        model: "m1",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 20,
          output_tokens: 2,
        },
      },
    })),
    {
      type: "user",
      timestamp: stamp(3),
      message: {
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    },
  ];
  const result = sessionModel(records);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].usage.input, 5);
  assert.equal(result.turns[0].durationMs, null);
  assert.equal(result.turns[0].requests.length, 1);
});
test("captured costs are differenced within a launch and reset on restart", () => {
  const records = [0, 10, 20].map((n) => ({
    type: "user",
    uuid: String(n),
    timestamp: stamp(n),
    message: { content: "hi" },
  }));
  const trace = [
    { type: "context", timestamp: stamp(0), payload: { systemPrompt: "base" } },
    {
      type: "result",
      timestamp: stamp(5),
      payload: { total_cost_usd: 1, duration_ms: 5000 },
    },
    {
      type: "result",
      timestamp: stamp(15),
      payload: { total_cost_usd: 3, duration_ms: 5000 },
    },
    { type: "context", timestamp: stamp(20), payload: { systemPrompt: "new" } },
    {
      type: "result",
      timestamp: stamp(25),
      payload: { total_cost_usd: 0.5, duration_ms: 5000 },
    },
  ];
  assert.deepEqual(
    sessionModel(records, { trace }).turns.map((t) => t.cost),
    [1, 2, 0.5],
  );
});
test("live server follows appended records and rejects cross-origin reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "session-debug-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  await writeFile(file, `${codex.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const { server, url } = await createInspector({ file, traceRoot: dir });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let response = await fetch(`${url}state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).turns.length, 1);
  await appendFile(
    file,
    `${JSON.stringify(event(10, "task_started", { turn_id: "t2" }))}\n`,
  );
  response = await fetch(`${url}state`);
  assert.equal((await response.json()).turns.length, 2);
  assert.equal(
    (
      await fetch(`${url}state`, {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${url}../../other`)).status, 404);
});

test("historical response views never pair a tool with its later result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "session-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  const records = [
    ...codex.slice(0, 4),
    {
      type: "response_item",
      timestamp: stamp(1),
      payload: {
        type: "function_call",
        call_id: "call",
        name: "tool",
        arguments: "{}",
      },
    },
    codex[4],
    {
      type: "response_item",
      timestamp: stamp(3),
      payload: {
        type: "function_call_output",
        call_id: "call",
        output: "FUTURE_RESULT",
      },
    },
    codex[6],
  ];
  await writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"));
  const { server, url } = await createInspector({ file, traceRoot: dir });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const snapshot = await (await fetch(`${url}state?through=r1`)).json();
  assert.equal(snapshot.snapshotAt, stamp(2));
  assert.equal(
    JSON.stringify(snapshot.entries).includes("FUTURE_RESULT"),
    false,
  );
  assert.equal(snapshot.turns.length, 1);
  const full = await (await fetch(`${url}state`)).json();
  assert.equal(JSON.stringify(full.entries).includes("FUTURE_RESULT"), true);
});

test("Claude background notifications remain inside their originating turn", () => {
  const records = [
    { type: "user", timestamp: stamp(0), message: { content: "hello" } },
    {
      type: "user",
      timestamp: stamp(1),
      message: { content: "<task-notification>done</task-notification>" },
    },
    {
      type: "user",
      timestamp: stamp(2),
      message: {
        content:
          "<new-message-arrived-while-you-were-working>also this</new-message-arrived-while-you-were-working>",
      },
    },
  ];
  assert.equal(sessionModel(records).turns.length, 1);
});
