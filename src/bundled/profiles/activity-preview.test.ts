import { expect, it, vi } from "vitest";
import { activityPreview } from "./activity-preview";

const now = Date.parse("2026-09-24T14:00:00Z");
const event = (
  update: unknown,
  channelId: string | null = "alpha",
  turnId = "turn",
) => ({
  kind: "acp_read",
  channelId,
  turnId,
  sessionId: "session",
  timestamp: new Date(now).toISOString(),
  payload: { method: "session/update", params: { update } },
});
const chunk = (text: string, messageId = "message") => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
});
const row = (value: unknown, id = "1", agent = "agent") => ({
  id,
  agent,
  receivedAt: now,
  kind: "acp_read",
  plaintext: JSON.stringify(value),
});
it("joins message chunks and updates tool titles/statuses without duplicating rows", () => {
  const rows = [
    row(event(chunk("Checking "))),
    row(event(chunk("the tests.")), "2"),
    row(
      event({
        sessionUpdate: "tool_call",
        toolCallId: "tool",
        title: "Run tests",
        status: "in_progress",
        rawInput: "secret",
      }),
      "3",
    ),
    row(
      event({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool",
        status: "completed",
        rawOutput: "secret",
      }),
      "4",
    ),
  ];
  expect(
    activityPreview(rows, "agent", "alpha").map(({ label, text }) => ({
      label,
      text,
    })),
  ).toEqual([
    { label: "Assistant", text: "Checking the tests." },
    { label: "Tool completed", text: "Run tests" },
  ]);
});
it("scopes mixed batch children before projecting and excludes foreign identities and unscoped data", () => {
  const batch = row({
    kind: "batch",
    payload: {
      events: [
        event(chunk("visible")),
        event(chunk("foreign"), "beta"),
        event(chunk("unscoped"), null),
      ],
    },
  });
  const rows = [batch, row(event(chunk("other identity")), "2", "other")];
  expect(
    activityPreview(rows, "agent", "alpha").map((item) => item.text),
  ).toEqual(["visible"]);
  expect(activityPreview(rows, "agent", "")).toEqual([]);
});
it("keeps turns separate and bounds the preview to three items of at most 601 characters", () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    row(event(chunk("x".repeat(800)), "alpha", String(i)), String(i)),
  );
  const items = activityPreview(rows, "agent", "alpha");
  expect(items).toHaveLength(3);
  expect(
    items.every(
      (item) => item.text.length === 601 && item.text.startsWith("…"),
    ),
  ).toBe(true);
});
it("ignores prompts, thoughts, malformed updates and unknown payloads", () => {
  const rows = [
    null,
    [],
    {
      kind: "acp_write",
      channelId: "alpha",
      payload: { method: "session/prompt", text: "secret" },
    },
    event({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "secret" },
    }),
    event({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", text: "secret" },
    }),
    event({ sessionUpdate: "tool_call" }),
    event({ sessionUpdate: "unknown" }),
  ].map((e, i) => row(e, String(i)));
  expect(activityPreview(rows, "agent", "alpha")).toEqual([]);
});
it("falls back to receipt time for invalid or future timestamps", () => {
  for (const timestamp of ["bad", "9999-01-01", null]) {
    expect(
      activityPreview(
        [row({ ...event(chunk("hello")), timestamp })],
        "agent",
        "alpha",
      )[0]?.timestamp,
    ).toBe(now);
  }
});

it("preserves interleaved message chunks even after three other items update", () => {
  const rows = [row(event(chunk("First ")), "0")];
  for (let i = 1; i <= 4; i++)
    rows.push(row(event(chunk("Other", String(i))), String(i)));
  rows.push(row(event(chunk("last")), "5"));
  expect(activityPreview(rows, "agent", "alpha").at(-1)?.text).toBe(
    "First last",
  );
});

it("reads scoped batch fields without serializing ignored nested results", () => {
  // Compact wire JSON stays small even when excluded diagnostic data is deep.
  const nested = `${"[".repeat(1500)}0${"]".repeat(1500)}`;
  const safe = event({
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "Safe title",
    status: "completed",
    rawOutput: "NESTED_RESULT",
  });
  const record = row({ kind: "batch", payload: { events: [safe] } });
  record.plaintext = record.plaintext.replace('"NESTED_RESULT"', nested);
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    const items = activityPreview([record], "agent", "alpha");
    // Identity tuples may be serialized, but never whole telemetry objects or
    // indentation-expanded diagnostic JSON.
    const serialized = stringify.mock.calls.map(([value, , space]) => ({
      value,
      space,
    }));
    expect(
      serialized.every(
        ({ value, space }) =>
          space === undefined &&
          Array.isArray(value) &&
          value.every(
            (part) => typeof part === "string" || typeof part === "number",
          ),
      ),
    ).toBe(true);
    expect(items).toMatchObject([
      { text: "Safe title", label: "Tool completed" },
    ]);
  } finally {
    stringify.mockRestore();
  }
});

it("rejects nested scope hints, foreign envelopes and malformed batch children", () => {
  const hidden = event(chunk("hidden"), null);
  const batch = {
    kind: "batch",
    channelId: "alpha",
    payload: {
      events: [
        null,
        [],
        { ...hidden, payload: { ...hidden.payload, channelId: "alpha" } },
        {
          kind: "batch",
          channelId: "alpha",
          payload: { events: [event(chunk("nested"))] },
        },
        event(chunk("foreign channel"), "beta"),
      ],
    },
  };
  expect(
    activityPreview(
      [
        row(batch),
        row(
          {
            kind: "batch",
            payload: { events: [event(chunk("foreign agent"))] },
          },
          "2",
          "other",
        ),
        { ...row(null), plaintext: "{" },
        row({ kind: "batch", channelId: "alpha", payload: { events: {} } }),
      ],
      "agent",
      "alpha",
    ),
  ).toEqual([]);
});

it.each(["tool_call", "tool_call_update"])(
  "splits unkeyed text at a same-turn %s boundary",
  (sessionUpdate) => {
    const unkeyed = (text: string) => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
    const rows = [
      row(event(unkeyed("Before tool. ")), "1"),
      row(
        event({ sessionUpdate, toolCallId: "tool", title: "Run tests" }),
        "2",
      ),
      row(event(unkeyed("After tool.")), "3"),
    ];
    expect(
      activityPreview(rows, "agent", "alpha").map(({ text }) => text),
    ).toEqual(["Before tool. ", "Run tests", "After tool."]);
  },
);

it("preserves keyed interleaving and isolates unkeyed tool boundaries by session and turn", () => {
  const tool = event({
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "Run tests",
  });
  for (const between of [
    tool,
    { ...tool, turnId: "other" },
    { ...tool, sessionId: "other" },
  ]) {
    const keyed = [
      row(event(chunk("Before ")), "1"),
      row(between, "2"),
      row(event(chunk("after")), "3"),
    ];
    expect(activityPreview(keyed, "agent", "alpha").at(-1)?.text).toBe(
      "Before after",
    );
    if (between !== tool) {
      const unkeyed = keyed.map((record) => ({
        ...record,
        plaintext: record.plaintext.replace(',"messageId":"message"', ""),
      }));
      expect(activityPreview(unkeyed, "agent", "alpha").at(-1)?.text).toBe(
        "Before after",
      );
    }
  }
});

it.each(["message", "tool"])(
  "keeps emoji intact at the %s clipping boundary",
  (kind) => {
    for (const [input, expected] of [
      [`😀${"x".repeat(598)}`, `😀${"x".repeat(598)}`],
      [`prefix😀${"x".repeat(598)}`, `…😀${"x".repeat(598)}`],
      [`prefix😀${"x".repeat(599)}`, `…${"x".repeat(599)}`],
      [`prefix😀${"x".repeat(600)}`, `…${"x".repeat(600)}`],
    ] as const) {
      const update =
        kind === "message"
          ? chunk(input)
          : {
              sessionUpdate: "tool_call",
              toolCallId: "tool",
              title: input,
            };
      const result = activityPreview([row(event(update))], "agent", "alpha")[0]
        ?.text;
      expect(result).toBe(expected);
      expect(result?.length).toBeLessThanOrEqual(601);
    }
  },
);
