import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_LENGTH } from "../relay/message-content";
import { prepareMarkdown } from "./markdown-preparation";

describe("prepareMarkdown", () => {
  it("shares a preparation by content within its bounds", () => {
    const content = "shared `code` content";
    const prepared = prepareMarkdown(content);
    expect(prepareMarkdown(content)).toBe(prepared);
    for (let index = 0; index < 300; index++) prepareMarkdown(`other ${index}`);
    expect(prepareMarkdown(content)).not.toBe(prepared);
    expect(prepareMarkdown(content)).toEqual(prepared);
    const long = `\`long\` ${"a".repeat(8_192)}`;
    expect(prepareMarkdown(long)).not.toBe(prepareMarkdown(long));
    expect(prepareMarkdown(long)).toEqual(prepareMarkdown(long));
  });

  it("keeps ordinary content and returns immutable literal ranges", () => {
    const prepared = prepareMarkdown("before `code` after");
    expect(prepared).toMatchObject({
      kind: "markdown",
      content: "before `code` after",
    });
    if (prepared.kind !== "markdown") throw new Error("expected Markdown");
    expect(prepared.literalRanges).toEqual([{ start: 7, end: 13 }]);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.literalRanges)).toBe(true);
    expect(Object.isFrozen(prepared.literalRanges[0])).toBe(true);
  });

  it("normalizes wrapped links outside literals and rescans normalized offsets", () => {
    const prepared = prepareMarkdown(
      "[Repository]\\([https://example.test](https://example.test)) and `[Literal]\\([https://example.test](https://example.test))`",
    );
    expect(prepared).toMatchObject({
      kind: "markdown",
      content:
        "[Repository](https://example.test) and `[Literal]\\([https://example.test](https://example.test))`",
    });
    if (prepared.kind !== "markdown") throw new Error("expected Markdown");
    expect(prepared.literalRanges).toEqual([
      { start: 0, end: 34 },
      { start: 39, end: prepared.content.length },
    ]);
  });

  it("preserves the signed body when normalization crosses the depth guard", () => {
    const content = `${"> ".repeat(98)}[label]\\(https://example.test\\)`;
    expect(prepareMarkdown(content)).toEqual({ kind: "plain", content });
  });

  it("falls back at both attacker-controlled boundaries", () => {
    expect(prepareMarkdown("a".repeat(MAX_MARKDOWN_LENGTH + 1)).kind).toBe(
      "plain",
    );
    expect(prepareMarkdown(`${"> ".repeat(20_000)}deep`).kind).toBe("plain");
  });
});
