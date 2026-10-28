import { describe, expect, it } from "vitest";
import {
  MAX_MARKDOWN_DEPTH,
  projectMarkdownAttachments,
  scanMarkdown,
} from "./message-content";

const attachment = "https://cdn.example/a.png";

describe("projectMarkdownAttachments", () => {
  it("returns bodies without link or image syntax unchanged", () => {
    const urls = new Set([attachment]);
    for (const content of [
      "",
      "plain prose",
      `bare ${attachment} and www.example.com and someone@example.com`,
      "**bold** _em_ `code` ~~gone~~ > quote",
      "- list\n  - nested\n\n1. one\n2. two",
      "```\nfenced ] ) !\n```",
      "| a | b |\n| - | - |\n| 1 | 2 |",
      `${"> ".repeat(MAX_MARKDOWN_DEPTH + 2)}deep`,
      "  leading space",
    ]) {
      // The full scan would find nothing to project here either.
      const scan = scanMarkdown(content);
      expect(scan.images).toEqual([]);
      expect(scan.links).toEqual([]);
      const projected = projectMarkdownAttachments(content, urls);
      expect(projected).toEqual({ content, seams: [], urls: [], names: [] });
      expect(Object.isFrozen(projected.seams)).toBe(true);
      expect(Object.isFrozen(projected.urls)).toBe(true);
      expect(Object.isFrozen(projected.names)).toBe(true);
    }
  });

  it("still trims trailing space unless the body is too deep", () => {
    expect(projectMarkdownAttachments("prose \n", new Set()).content).toBe(
      "prose",
    );
    const deep = `${"> ".repeat(MAX_MARKDOWN_DEPTH + 2)}deep\n`;
    expect(projectMarkdownAttachments(deep, new Set()).content).toBe(deep);
  });

  it("projects images and attachment links", () => {
    expect(
      projectMarkdownAttachments(
        `look ![](${attachment}) and [photo](${attachment})`,
        new Set([attachment]),
      ),
    ).toEqual({
      content: "look  and",
      seams: [5],
      urls: [attachment],
      names: [{ url: attachment, name: "photo" }],
    });
    expect(
      projectMarkdownAttachments(`see <${attachment}>`, new Set([attachment]))
        .content,
    ).toBe("see");
  });
});
