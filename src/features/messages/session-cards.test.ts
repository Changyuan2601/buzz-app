import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { separateSessionCards } from "./session-cards";

const link = "[Session: PR 45 fixes](buzz://channel/session-id)";
const row = (content: string): ChannelMessage => ({
  id: "message",
  channelId: "channel",
  authorId: "author",
  content,
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});

it("separates multiple session cards while preserving the caption's Markdown and the original message", () => {
  const source = row(`**Please review** ${link}\n\nAnd this one: ${link}`);
  const result = separateSessionCards(source, []);
  expect(result.cards.map((card) => card.content)).toEqual([link, link]);
  expect(result.caption.content).toContain("**Please review**");
  expect(result.caption.content).toContain("And this one:");
  expect(result.caption.content).not.toContain("buzz:");
  expect(source.content).toContain(link);
});

it("removes empty emphasis and paragraph wrappers for card-only messages", () => {
  const result = separateSessionCards(row(`**${link}**`), []);
  expect(result.cards).toHaveLength(1);
  expect(result.caption.content.trim()).toBe("");
});

it.each([
  `\`${link}\``,
  `\`\`\`md\n${link}\n\`\`\``,
  `> ${link}`,
  `||${link}||`,
  "[Session: Example](https://example.com)",
  `[Session: Message](buzz://channel/session-id/${"a".repeat(64)})`,
])("retains literal, quoted, hidden and non-session content: %s", (content) => {
  const source = row(content);
  expect(separateSessionCards(source, [])).toEqual({
    caption: source,
    cards: [],
    ranges: [],
  });
});

it("recognizes bare links to known sessions and respects known ordinary channels", () => {
  expect(
    separateSessionCards(row("buzz://channel/session-id"), [
      { id: "session-id", name: "Name", channelType: "session" },
    ]).cards,
  ).toHaveLength(1);
  expect(
    separateSessionCards(row(link), [
      { id: "session-id", name: "Name", channelType: "stream" },
    ]).cards,
  ).toHaveLength(0);
});

it("retains existing mention seams and adds a boundary where a card was removed", () => {
  const source = {
    ...row(`@Al${link}ex suffix`),
    attachmentSeams: [0, 3 + link.length + 2],
  };
  const { caption } = separateSessionCards(source, []);
  expect(caption.content).toBe("@Al ex suffix");
  expect(caption.attachmentSeams).toEqual(expect.arrayContaining([0, 3, 6]));
});
