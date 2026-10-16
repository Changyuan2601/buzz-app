import { afterEach, describe, expect, it, vi } from "vitest";
import * as messageContent from "../relay/message-content";
import { MAX_MARKDOWN_LENGTH } from "../relay/message-content";
import { prepareMarkdown } from "./markdown-preparation";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("skips the scan for prose that has no literal or nesting syntax", () => {
    const scan = vi.spyOn(messageContent, "scanMarkdown");
    const prose =
      "Plain prose.\nNext line!\n\n# Title & co\nend\\\n|| hidden ||";
    expect(prepareMarkdown(prose)).toEqual({
      kind: "markdown",
      content: prose,
      literalRanges: [],
      spoilerDelimiters: [prose.indexOf("||"), prose.lastIndexOf("||")],
    });
    expect(scan).not.toHaveBeenCalled();

    for (const content of [
      "`code`",
      "~~~\nfence\n~~~",
      "[label](https://example.test)",
      "<https://example.test>",
      "a\n> quote",
      "*em*",
      "_em_",
      "a\n\n    indented",
      "\tindented",
      "- item",
      "+ item",
      "1. item",
      "\uFEFF- item",
      "\uFEFF    code",
    ]) {
      scan.mockClear();
      prepareMarkdown(content);
      expect(scan, content).toHaveBeenCalledOnce();
    }
  });

  it("takes the scan-free path only where a scan finds nothing and stays shallow", () => {
    const { scanMarkdown } = messageContent;
    const scan = vi.spyOn(messageContent, "scanMarkdown");
    const alphabet = [
      ..."ab #=&;!:|\\\n\r\t\uFEFF\u2028`~[]()<>*_-+.)1@/",
      "&#96;",
      "&#x3C;",
      "&lt;",
      "  \n",
      "\r\n",
      "===",
      "www.a.test",
      "a:b",
      "<a>",
      "<!--",
      "\n- ",
      "\n+ ",
      "\n1. ",
      "\n1) ",
      "~~~",
      "[a]",
      "[a]: b",
      "](b)",
    ];
    let seed = 1;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const literals = new Set([
      "code",
      "inlineCode",
      "link",
      "linkReference",
      "image",
      "imageReference",
      "definition",
      "html",
    ]);
    type Node = { type: string; children?: Node[] };
    const depth = (node: Node): number =>
      1 + Math.max(0, ...(node.children ?? []).map(depth));
    const types = (node: Node): string[] => [
      node.type,
      ...(node.children ?? []).flatMap(types),
    ];
    let skipped = 0;
    for (let sample = 0; sample < 4000; sample++) {
      let content = "";
      const length = 1 + Math.floor(random() * 24);
      for (let index = 0; index < length; index++)
        content += alphabet[Math.floor(random() * alphabet.length)];
      scan.mockClear();
      const prepared = prepareMarkdown(content);
      if (scan.mock.calls.length) continue;
      skipped++;
      const { tree, tooDeep } = scanMarkdown(content);
      expect(tooDeep, content).toBe(false);
      expect(depth(tree as Node), content).toBeLessThanOrEqual(3);
      expect(
        types(tree as Node).filter((type) => literals.has(type)),
        content,
      ).toEqual([]);
      expect(prepared, content).toMatchObject({ kind: "markdown", content });
    }
    expect(skipped).toBeGreaterThan(100);
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
    expect(prepareMarkdown(`\uFEFF${"- ".repeat(100)}deep`).kind).toBe("plain");
  });
});
