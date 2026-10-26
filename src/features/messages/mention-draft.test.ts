import { expect, it } from "vitest";
import {
  addressingOnly,
  editMentionDraft,
  hasDraftContent,
  mentionDraft,
  followupDraft,
  replaceMentionDraft,
} from "./mention-draft";
const first = { pubkey: "a".repeat(64), name: "Honey", start: 0, end: 6 };
const second = { pubkey: "b".repeat(64), name: "Honey", start: 7, end: 13 };
it("deleting one namesake does not leave its recipient attached to the other", () => {
  const draft = mentionDraft({
    text: "@Honey @Honey help",
    recipients: [first, second],
  });
  const edited = editMentionDraft(draft, "@Honey help");
  // Text alone cannot identify which identical token was deleted. Fail closed.
  expect(edited.recipients).toEqual([]);
});
it("actual edits before a mention move its span; extending or replacing a name drops intent", () => {
  const draft = mentionDraft({ text: "@Honey help", recipients: [first] });
  const edit = (text: string, start: number, end = start) =>
    editMentionDraft(draft, text, {
      text: draft.text,
      start,
      end,
      inputType: "insertText",
    });
  expect(edit("Hi @Honey help", 0).recipients[0]).toMatchObject({
    start: 3,
    end: 9,
  });
  expect(edit("@Honeybee help", 6).recipients).toEqual([]);
  expect(edit("@Honey help me", draft.text.length).recipients).toEqual([first]);
  expect(edit("@Honey help", 0, 6).recipients).toEqual([]);
  expect(editMentionDraft(draft, "Hi @Honey help").recipients).toEqual([]);
  expect(editMentionDraft(draft, draft.text).recipients).toEqual([]);
});
it("replacement edits keep only mentions outside the browser's target range", () => {
  const draft = mentionDraft({
    text: "@Honey @Honey what's next",
    recipients: [first, second],
  });
  const edit = (start: number, end: number, inserted: string) =>
    editMentionDraft(
      draft,
      draft.text.slice(0, start) + inserted + draft.text.slice(end),
      { text: draft.text, start, end, inputType: "insertReplacementText" },
    );
  const quote = draft.text.indexOf("'");
  expect(edit(quote, quote + 1, "’").recipients).toEqual([first, second]);
  // Even same-text autocorrect on a selected name must revoke that identity.
  expect(edit(0, 6, "@Honey").recipients).toEqual([second]);
  expect(edit(7, 13, "@Honey").recipients).toEqual([first]);
  expect(
    editMentionDraft(draft, draft.text.replaceAll("'", "’")).recipients,
  ).toEqual([]);
});

it("inline Markdown delimiters end a mention as the timeline binds it, but an underscore extends the name", () => {
  for (const text of ["**@Honey**", "~~@Honey~~", "`@Honey`", "*@Honey*"]) {
    const start = text.indexOf("@Honey");
    expect(
      mentionDraft({
        text,
        recipients: [{ ...first, start, end: start + 6 }],
      }).recipients,
      text,
    ).toEqual([{ ...first, start, end: start + 6 }]);
  }
  expect(
    mentionDraft({
      text: "_@Honey_",
      recipients: [{ ...first, start: 1, end: 7 }],
    }).recipients,
  ).toEqual([]);
});

it("legacy prose and malformed persisted metadata never infer recipients", () => {
  expect(mentionDraft("@Honey").recipients).toEqual([]);
  for (const recipient of [
    { ...first, start: -1 },
    { ...first, pubkey: "invalid" },
    { ...first, end: 4 },
  ]) {
    expect(
      mentionDraft({ text: "@Honey", recipients: [recipient] }).recipients,
    ).toEqual([]);
  }
});

it("pasting a namesake while extending the chosen token cannot transfer notification intent", () => {
  const draft = mentionDraft({ text: "@Honey ", recipients: [first] });
  expect(editMentionDraft(draft, "@Honeybee @Honey ").recipients).toEqual([]);
});

it("captured replacement ranges never transfer identity across a matrix of same-name edits", () => {
  for (const text of ["@Honey ", "Hi @Honey help", "@Honey @Honey help"]) {
    const start = text.indexOf("@Honey");
    const draft = mentionDraft({
      text,
      recipients: [{ ...first, start, end: start + 6 }],
    });
    for (let from = 0; from <= text.length; from++) {
      for (let to = from; to <= text.length; to++) {
        for (const insertion of [
          "",
          " ",
          "Hi ",
          "@Honey",
          "bee @Honey",
          "@Honey @Honey ",
        ]) {
          const actual = replaceMentionDraft(draft, from, to, insertion);
          const inferred = editMentionDraft(draft, actual.text, {
            text,
            start: from,
            end: to,
            inputType: "insertFromPaste",
          });
          for (const recipient of inferred.recipients)
            expect(
              actual.recipients,
              JSON.stringify({ text, from, to, insertion }),
            ).toContainEqual(recipient);
        }
      }
    }
  }
});

it("followup drafts deduplicate exact keys, preserve namesakes, and enforce draft bounds", () => {
  expect(followupDraft([first, second, first])).toEqual({
    text: "@Honey @Honey ",
    recipients: [first, second],
  });
  const many = Array.from({ length: 33 }, (_, i) => ({
    pubkey: i.toString(16).padStart(64, "0"),
    name: `Agent ${i}`,
  }));
  expect(followupDraft(many).recipients).toHaveLength(32);
  expect(
    followupDraft([{ ...first, name: "x".repeat(15998) }, second]).text,
  ).toHaveLength(16000);
  expect(followupDraft([{ ...first, name: "x".repeat(15999) }])).toEqual({
    text: "",
    recipients: [],
  });
  expect(followupDraft([])).toEqual({ text: "", recipients: [] });
});

it("restores chat cards from drafts saved under the old sessionCards field", () => {
  const link = "[Chat: Fix](buzz://channel/chat-id)";
  expect(mentionDraft({ text: "hi", sessionCards: [link] }).chatCards).toEqual([
    link,
  ]);
  expect(
    mentionDraft({ text: "hi", chatCards: [link], sessionCards: ["x"] })
      .chatCards,
  ).toEqual([link]);
});
it("text, chat cards or files are draft content; blank text alone is not", () => {
  const blank = mentionDraft({ text: "  ", recipients: [] });
  expect(hasDraftContent(blank)).toBe(false);
  expect(hasDraftContent({ ...blank, chatCards: ["card"] })).toBe(true);
  expect(hasDraftContent(blank, 1)).toBe(true);
  // A typed tag is text the person put there.
  expect(hasDraftContent(followupDraft([first]))).toBe(true);
  expect(
    hasDraftContent(mentionDraft({ text: "@Honey", recipients: [] })),
  ).toBe(true);
});
it("addressingOnly holds for selected tags with no prose or chat card", () => {
  const tags = mentionDraft({
    text: "@Honey @Honey ",
    recipients: [first, second],
  });
  expect(addressingOnly(tags)).toBe(true);
  expect(addressingOnly(followupDraft([first]))).toBe(true);
  expect(addressingOnly(mentionDraft({ text: "  ", recipients: [] }))).toBe(
    false,
  );
  // Typed @Name text without a selected identity is the person's prose.
  expect(addressingOnly(mentionDraft({ text: "@Honey", recipients: [] }))).toBe(
    false,
  );
  expect(
    addressingOnly(
      mentionDraft({ text: "@Honey @Honey hi", recipients: [first, second] }),
    ),
  ).toBe(false);
  expect(addressingOnly({ ...tags, chatCards: ["card"] })).toBe(false);
});
