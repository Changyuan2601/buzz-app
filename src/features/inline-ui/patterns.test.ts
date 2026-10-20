import { expect, it } from "vitest";
import {
  inlineUiContent,
  inlineUiMessage,
  readInlineUi,
  UI_TAG,
} from "./patterns";

const ui = { pattern: "choice" as const, options: ["Warm", "Direct"] };

it("accepts a choice and trims its answers", () => {
  expect(
    readInlineUi({ pattern: "choice", options: [" Warm ", "Direct"] }),
  ).toEqual({ ui });
});

it.each([
  [undefined, "ui must be an object."],
  [
    { pattern: "form", options: ["a", "b"] },
    "ui.pattern must be choice or profile.",
  ],
  [{ pattern: "choice", options: ["a"] }, "ui.options must list 2–6 answers."],
  [
    { pattern: "choice", options: ["a", "b", "c", "d", "e", "f", "g"] },
    "ui.options must list 2–6 answers.",
  ],
  [
    { pattern: "choice", options: ["a", "two\nlines"] },
    "Each ui option must be one line of 1–80 characters.",
  ],
  [
    { pattern: "choice", options: ["a", "x".repeat(81)] },
    "Each ui option must be one line of 1–80 characters.",
  ],
  [{ pattern: "choice", options: ["Yes", "yes"] }, "ui options repeat “yes”."],
  [
    { pattern: "choice", options: ["a", "b"], style: "big" },
    "ui has unknown fields: style.",
  ],
])("explains why %j is not a pattern", (value, error) => {
  expect(readInlineUi(value)).toEqual({ error });
});

it("writes a numbered plain-text version and reads the pattern back", () => {
  const content = inlineUiContent("What tone should I use?  ", ui);
  expect(content).toBe(
    "What tone should I use?\n\n1. Warm\n2. Direct\n\nOr reply with your own answer.",
  );
  expect(inlineUiMessage(content, [[UI_TAG, JSON.stringify(ui)]])).toEqual({
    ui,
    text: "What tone should I use?",
  });
});

it("stays plain text when the tag is invalid or the content no longer matches it", () => {
  const content = inlineUiContent("Tone?", ui);
  const tag = [UI_TAG, JSON.stringify(ui)];
  expect(inlineUiMessage(content, [])).toBeUndefined();
  expect(inlineUiMessage(content, [[UI_TAG, "{"]])).toBeUndefined();
  expect(
    inlineUiMessage(content, [
      [UI_TAG, JSON.stringify({ ...ui, options: ["Warm"] })],
    ]),
  ).toBeUndefined();
  expect(
    inlineUiMessage(content.replace("Direct", "Blunt"), [tag]),
  ).toBeUndefined();
  expect(
    inlineUiMessage(inlineUiContent("", ui).trimStart(), [tag]),
  ).toBeUndefined();
});
