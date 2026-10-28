import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { describe, expect, it } from "vitest";

// patches/micromark: see patches/README.md.
describe("cached Markdown constructs", () => {
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
