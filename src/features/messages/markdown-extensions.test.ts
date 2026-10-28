import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

// patches/remark-gfm and patches/micromark: see patches/README.md.
describe("shared Markdown extensions", () => {
  const attach = (options?: Parameters<typeof remarkGfm>[0]) => {
    const data: Record<string, unknown[]> = {};
    (remarkGfm as (this: unknown, options?: unknown) => void).call(
      { data: () => data },
      options,
    );
    return data;
  };

  it("attaches the same default GFM extensions to every processor", () => {
    const [first, second] = [attach(), attach()];
    for (const key of [
      "micromarkExtensions",
      "fromMarkdownExtensions",
      "toMarkdownExtensions",
    ])
      expect(second[key]?.[0]).toBe(first[key]?.[0]);
    expect(attach({ singleTilde: false }).micromarkExtensions?.[0]).not.toBe(
      first.micromarkExtensions?.[0],
    );
  });

  it("parses each extension list with its own constructs", () => {
    const strike = [gfmStrikethrough()];
    const kinds = (extensions?: typeof strike) =>
      fromMarkdown("~~gone~~", {
        ...(extensions && { extensions }),
        mdastExtensions: [gfmStrikethroughFromMarkdown()],
      }).children.map((node) =>
        "children" in node ? node.children[0]?.type : node.type,
      );
    for (let round = 0; round < 2; round++) {
      expect(kinds()).toEqual(["text"]);
      expect(kinds(strike)).toEqual(["delete"]);
      expect(kinds([])).toEqual(["text"]);
    }
  });
});
