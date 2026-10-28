import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_LENGTH } from "../relay/message-content";
import { fromMarkdown } from "mdast-util-from-markdown";
import { prepareMarkdown, takeScannedMarkdown } from "./markdown-preparation";

describe("prepareMarkdown", () => {
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

  it("hands its final parse to one renderer of exactly that content", () => {
    const content = "Follow-ups:\n- one\n  - **two**";
    prepareMarkdown(content);
    expect(takeScannedMarkdown(`${content} `)).toBeUndefined();
    prepareMarkdown(content);
    expect(takeScannedMarkdown(content)).toEqual(fromMarkdown(content));
    expect(takeScannedMarkdown(content)).toBeUndefined();
    // A normalized body hands over the parse of the normalized content.
    const prepared = prepareMarkdown("[label]\\(https://example.test)");
    expect(takeScannedMarkdown(prepared.content)).toEqual(
      fromMarkdown(prepared.content),
    );
  });
});
