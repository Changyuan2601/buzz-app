import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { cardAnswers } from "./card-answers";

const viewer = "a".repeat(64),
  agent = "b".repeat(64);
const message = (
  id: string,
  authorId: string,
  content: string,
  extra: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id,
  channelId: "c",
  authorId,
  content,
  createdAt: 100,
  mentions: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  participants: [],
  ...extra,
});
const card = (id: string, pattern: "choice" | "profile" = "choice") =>
  message(id, agent, "Pick one", {
    inlineUi: { ui: { pattern, options: ["Short", "Detailed"] }, text: "Pick" },
  });

it("gives a choice card the viewer's next reply and drops its repeat bubble", () => {
  const rows = [
    card("q1"),
    message("a1", viewer, "Short"),
    message("next", agent, "Thanks"),
  ];
  const result = cardAnswers(rows, viewer, new Set([agent]));
  expect(result.rows.map((row) => row.id)).toEqual(["q1", "next"]);
  expect(result.answers.get("q1")).toBe("Short");
});

it("keeps replies a card can't show whole, or that need a retry, as messages", () => {
  const agents = new Set([agent]);
  for (const reply of [
    message("a", viewer, "Line one\nLine two"),
    message("a", viewer, "x".repeat(501)),
    message("a", viewer, "Short", { delivery: "failed" }),
    message("a", viewer, "Short", { threadRootId: "q" }),
    message("a", "d".repeat(64), "Short"),
  ])
    expect(
      cardAnswers([card("q"), reply], viewer, agents).rows.map((r) => r.id),
    ).toEqual(["q", "a"]);
  // Profile cards show the saved name, not a reply; unknown authors show none.
  expect(
    cardAnswers(
      [card("q", "profile"), message("a", viewer, "Hi")],
      viewer,
      agents,
    ).rows,
  ).toHaveLength(2);
  expect(
    cardAnswers([card("q"), message("a", viewer, "Short")], viewer, new Set())
      .rows,
  ).toHaveLength(2);
});
