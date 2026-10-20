// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ActivityTranscript } from "./ActivityTranscript";
import { codexTurns } from "../../bundled/codex/transcript";
import { restoreRecordedTools } from "../../bundled/codex/recorded-tools";

afterEach(cleanup);

it.each([
  ["failed", "Failed"],
  ["terminated", "Terminated"],
])("shows %s script status before opening its output", (status, label) => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  turns[0]?.items.push({
    id: "script",
    toolCallId: "script",
    at: 1000,
    type: "tool",
    title: "exec",
    kind: "execute",
    status,
    input: "throw new Error('failed')",
    output: `Script ${status}\nOutput:\nError`,
    paths: [],
    diffs: [],
    truncated: false,
  });
  render(
    <ActivityTranscript
      transcript={{ turns, unknownThread: 0 }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText(label, { exact: true })).toBeVisible();
  expect(
    screen.getByText("exec", { exact: true }).closest("details"),
  ).not.toHaveAttribute("open");
});

it("shows the recorded tool name, highlights tool calls, and keeps script text intact without raw details", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  const script =
    "text(await tools.buzz__channels({all:true}));\ntext(await tools.clock__curr_time({}));";
  restoreRecordedTools(
    turns,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "script",
          name: "exec",
          input: script,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "script",
          output: [
            {
              type: "input_text",
              text: "Script completed\nOutput:\nchannel list",
            },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns, unknownThread: 0 }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  await user.click(screen.getByText("exec", { exact: true }));
  const channels = screen.getByText("tools.buzz__channels", { exact: true });
  expect(channels).toBeVisible();
  expect(channels).toHaveClass("text-accent");
  expect(
    screen.getByText("tools.clock__curr_time", { exact: true }),
  ).toHaveClass("text-accent");
  expect(channels.closest("pre")?.textContent).toBe(script);
  expect(
    screen.getByText(/^Script completed Output: channel list$/),
  ).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});

it("shows a failed nested call on the collapsed script while preserving the script's status", () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "commandExecution",
            id: "failed",
            command: "false",
            status: "failed",
            aggregatedOutput: "exit 1",
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const turn = turns[0];
  const failed = turn?.items[0];
  if (!turn || failed?.type !== "tool") throw new Error("Missing failed tool");
  turn.items = [
    {
      ...failed,
      id: "script",
      toolCallId: "script",
      title: "exec",
      status: "completed",
      children: [failed],
    },
  ];
  render(
    <ActivityTranscript
      transcript={{ turns, unknownThread: 0 }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText("· 1 failed call")).toBeVisible();
  const script = screen.getByText("exec", { exact: true }).closest("details");
  expect(script).not.toHaveAttribute("open");
  expect(script).toHaveAttribute("data-status", "completed");
});

it("discloses tool arguments and results without raw details, including a posted send", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "dynamicToolCall",
            id: "read",
            namespace: "buzz",
            tool: "read",
            arguments: { limit: 2 },
            status: "completed",
            contentItems: [{ type: "inputText", text: "two messages" }],
            success: true,
          },
          {
            type: "dynamicToolCall",
            id: "send",
            namespace: "buzz",
            tool: "send",
            arguments: { text: "Done" },
            status: "completed",
            contentItems: [{ type: "inputText", text: "sent" }],
            success: true,
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns, unknownThread: 0 }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  const tool = screen.getByText("buzz.read").closest("details");
  expect(tool).not.toHaveAttribute("open");
  await user.click(screen.getByText("buzz.read"));
  expect(tool).toHaveAttribute("open");
  expect(screen.getByText('{ "limit": 2 }')).toBeVisible();
  expect(screen.getByText("two messages")).toBeVisible();
  expect(screen.getByText("Done")).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});
