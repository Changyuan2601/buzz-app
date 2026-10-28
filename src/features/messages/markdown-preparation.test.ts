import { afterEach, describe, expect, it, vi } from "vitest";
import * as messageContent from "../relay/message-content";
import { MAX_MARKDOWN_LENGTH } from "../relay/message-content";
import {
  isLiteralMarkdownContext,
  prepareMarkdown,
} from "./markdown-preparation";

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
      const prepared = prepareMarkdown(content);
      if (prepared.kind === "markdown") void prepared.literalRanges;
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
      if (prepared.kind === "markdown") void prepared.literalRanges;
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

  it("scans short syntax only when literal ranges are read", () => {
    const scan = vi.spyOn(messageContent, "scanMarkdown");
    const prepared = prepareMarkdown("- item with `code`");
    expect(scan).not.toHaveBeenCalled();
    if (prepared.kind !== "markdown") throw new Error("expected Markdown");
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared.literalRanges).toEqual([{ start: 12, end: 18 }]);
    expect(prepared.literalRanges).toBe(prepared.literalRanges);
    expect(scan).toHaveBeenCalledOnce();

    for (const content of [
      "[a]\\(https://example.test)",
      "[a]([https://example.test](https://example.test))",
      "1".repeat(50),
    ]) {
      scan.mockClear();
      prepareMarkdown(content);
      expect(scan, content).toHaveBeenCalled();
    }
  });

  it("defers the scan only below the depth guard", () => {
    const { scanMarkdown } = messageContent;
    const scan = vi.spyOn(messageContent, "scanMarkdown");
    for (const marker of ["- ", "+ ", "* ", "1. ", "> "]) {
      const shallow = `${marker.repeat(49)}a`;
      scan.mockClear();
      expect(prepareMarkdown(shallow).kind, marker).toBe("markdown");
      expect(scan, marker).not.toHaveBeenCalled();
      expect(scanMarkdown(shallow).tooDeep, marker).toBe(false);
      if (marker !== "> ")
        expect(prepareMarkdown(`${marker.repeat(50)}a`).kind, marker).toBe(
          "plain",
        );
    }

    const alphabet = [
      ..."ab >*_+-1[]()`<\n\t",
      "> ",
      "- ",
      "* ",
      "1. ",
      "**",
      "__",
      "[a](b)",
      "[a][b]",
      "\n[b]: c",
      "![a](b)",
      "`c`",
      "\n```\n",
      "\n    ",
      "<b>",
      "<http://a>",
    ];
    let seed = 3;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    type Node = {
      type: string;
      children?: Node[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    const literal = (tree: Node) => {
      const ranges: { start: number; end: number }[] = [];
      const visit = (node: Node) => {
        if (isLiteralMarkdownContext(node.type)) {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined)
            ranges.push({ start, end });
          return;
        }
        for (const child of node.children ?? []) visit(child);
      };
      visit(tree);
      return ranges;
    };
    let deferred = 0;
    for (let sample = 0; sample < 1500; sample++) {
      let content = "";
      const length = 1 + Math.floor(random() * 90);
      for (let index = 0; index < length; index++)
        content += alphabet[Math.floor(random() * alphabet.length)];
      scan.mockClear();
      const prepared = prepareMarkdown(content);
      if (scan.mock.calls.length) continue;
      deferred++;
      const { tree, tooDeep } = scanMarkdown(content);
      expect(tooDeep, content).toBe(false);
      expect(prepared, content).toMatchObject({ kind: "markdown", content });
      if (prepared.kind !== "markdown") continue;
      expect(prepared.literalRanges, content).toEqual(literal(tree as Node));
    }
    expect(deferred).toBeGreaterThan(300);
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
