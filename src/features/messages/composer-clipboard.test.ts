// @vitest-environment jsdom
import { expect, it } from "vitest";
import { buzzCopyMarkdown, composerClipboard } from "./composer-clipboard";
import { composerSchema } from "./composer-document";

it("copies plain text and unlinked tokens as text and round-trips clipboard HTML", () => {
  const source = "<img src=x onerror=alert(1)> & text";
  const doc = composerSchema.nodes.doc.create(
    null,
    composerSchema.nodes.paragraph.create(null, [
      composerSchema.text("before "),
      composerSchema.nodes.token.create({ source }),
      composerSchema.text(" after"),
    ]),
  );
  const copied = composerClipboard(doc, document);
  const html = new DOMParser().parseFromString(copied.html, "text/html");
  expect(html.body.textContent).toBe(`before ${source} after`);
  expect(html.querySelector("img")).toBeNull();
  expect(copied.text).toBe(`before ${source} after`);
  expect(buzzCopyMarkdown(copied.html)).toBe(copied.text);
});
