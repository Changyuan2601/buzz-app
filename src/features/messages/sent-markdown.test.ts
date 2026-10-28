import { expect, it } from "vitest";
import { sentMarkdown } from "./composer-markdown";
import type { MentionDraft } from "./mention-draft";
import { startingChatTitle } from "../solo/chat-title";

const honey = { pubkey: "a".repeat(64), name: "Honey" };
const bea = { pubkey: "b".repeat(64), name: "Bea Lin" };
const draft = (text: string, extra: Partial<MentionDraft> = {}) => ({
  text,
  recipients: [],
  to: [honey, bea],
  ...extra,
});

it("leads a sent message with its recipients as mentions", () => {
  expect(sentMarkdown(draft("hi there"))).toBe("@Honey @Bea Lin hi there");
  expect(sentMarkdown(draft(""))).toBe("@Honey @Bea Lin");
  expect(sentMarkdown({ text: "plain", recipients: [] })).toBe("plain");
});

it.each([
  ["# Title", "@Honey @Bea Lin\n\n# Title"],
  ["- one\n- two", "@Honey @Bea Lin\n\n- one\n- two"],
  ["> quoted", "@Honey @Bea Lin\n\n> quoted"],
  ["```\ncode\n```", "@Honey @Bea Lin\n\n```\ncode\n```"],
  ['[img]: https://x.test "t"', '@Honey @Bea Lin\n\n[img]: https://x.test "t"'],
  ["***", "@Honey @Bea Lin\n\n***"],
  ["a | b\n--- | ---\n1 | 2", "@Honey @Bea Lin\n\na | b\n--- | ---\n1 | 2"],
  ["Title\n===", "@Honey @Bea Lin\n\nTitle\n==="],
])("starts a block body after a blank line: %j", (text, sent) => {
  expect(sentMarkdown(draft(text))).toBe(sent);
});

it("puts staged chat cards after the mentions", () => {
  const link = "[Chat: Fix](buzz://channel/chat-id)";
  expect(sentMarkdown(draft("caption", { chatCards: [link] }))).toBe(
    `@Honey @Bea Lin\n\n${link}\n\ncaption`,
  );
});

it("does not repeat a name the text already mentions", () => {
  expect(sentMarkdown(draft("thanks @Honey!"))).toBe("@Bea Lin thanks @Honey!");
  expect(sentMarkdown(draft("@Honey and @Bea Lin"))).toBe(
    "@Honey and @Bea Lin",
  );
  // A longer name or an address is not the mention.
  expect(sentMarkdown(draft("@Honeybee ok"))).toBe(
    "@Honey @Bea Lin @Honeybee ok",
  );
});

it("titles a Solo chat from its text, not the mentions that lead it", () => {
  const sent = sentMarkdown(draft("Plan the week"));
  const recipients = [
    { ...honey, start: 0, end: 6 },
    { ...bea, start: 7, end: 15 },
  ];
  expect(startingChatTitle({ text: sent, recipients })).toBe("Plan the week");
});
