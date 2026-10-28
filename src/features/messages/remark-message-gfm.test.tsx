import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { remarkMessageGfm } from "./remark-message-gfm";

function parsed(content: string, gfm: ReturnType<typeof remarkMessageGfm>) {
  let tree: unknown;
  const capture = () => (root: unknown) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <Markdown remarkPlugins={[gfm, capture]} skipHtml>
      {content}
    </Markdown>,
  );
  return { tree, html };
}

describe("remarkMessageGfm", () => {
  it.each([
    "see www.example.test",
    "see WWW.example.test",
    "https://example.test",
    "HTTP://example.test",
    "mail@example.test",
    "www\\.example.test",
    "user&#064;example.test",
    "note[^1]\n\n[^1]: detail",
    "- [ ] task",
  ])("keeps all of GFM for %j", (content) => {
    expect(remarkMessageGfm(content)).toBe(remarkGfm);
  });

  it("parses like remark-gfm wherever it leaves out autolinks", () => {
    const alphabet = [
      ..."ab w.h:/|-~*_`>#\n\t1",
      "www",
      "http",
      "s://",
      "a.test",
      "\n| a | b |",
      "\n|---|:-:|",
      "\n:-",
      "\n-:",
      "\n: -",
      "\n- :",
      "~",
      "~~",
      "\n- ",
      "\n1. ",
      "&#",
      "&amp;",
      "@",
      "[",
      "]",
      "\\",
      "www\\.a.test",
      "www&#46;a.test",
      "b&#64;a.test",
      "[ ] ",
      "[x] ",
      "[^1]",
      "\n[^1]: b",
      "http://a.test",
      " b@a.test",
      "\n- [ ] a",
      "a[^1]\n\n[^1]: b",
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    let reduced = 0;
    for (let sample = 0; sample < 10000; sample++) {
      let content = "";
      const length = 1 + Math.floor(random() * 20);
      for (let index = 0; index < length; index++)
        content += alphabet[Math.floor(random() * alphabet.length)];
      const plugin = remarkMessageGfm(content);
      if (plugin === remarkGfm) continue;
      reduced++;
      expect(parsed(content, plugin), content).toEqual(
        parsed(content, remarkGfm),
      );
    }
    expect(reduced).toBeGreaterThan(500);
  });
});
