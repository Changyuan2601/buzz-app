import { expect, it } from "vitest";
import { scanMarkdown } from "../relay/message-content";
import { scanComposerText } from "./composer-scan";

type Node = ReturnType<typeof scanMarkdown>["tree"];

/** Everything decorations derive from a scan: literal and image spans, links. */
function decorated(
  scan: Pick<ReturnType<typeof scanMarkdown>, "tree" | "links" | "tooDeep">,
) {
  const spans: string[] = [];
  const pending: Node[] = [scan.tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (
      [
        "code",
        "inlineCode",
        "image",
        "imageReference",
        "definition",
        "html",
      ].includes(node.type)
    )
      spans.push(
        `${node.type}:${node.position?.start.offset}-${node.position?.end.offset}`,
      );
    else pending.push(...(node.children ?? []));
  }
  return {
    spans,
    links: scan.links.map((link) => [link.url, link.position?.start.offset]),
    tooDeep: scan.tooDeep,
  };
}

it("decorates exactly as a full Markdown scan", () => {
  const pieces = [
    ..."abcXYZ 09.,!?;:'\"()#$%/{}=_^&|@\\",
    "    ",
    "  ",
    "\n",
    "\t",
    "`",
    "```",
    "~~~",
    "[x]",
    "[x]: https://a.example",
    "![g](https://a.example/g.gif)",
    "<b>",
    "<https://a.example>",
    "https://a.example",
    "> ",
    "- ",
    "* ",
    "+ ",
    "1. ",
    "2) ",
    "**b**",
    "_i_",
    "é🎉",
    "&#96;",
    "&lt;",
  ];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  const texts = [
    "",
    "Checking the draft under pressure",
    "    code",
    "a\n    b",
  ];
  for (let sample = 0; sample < 4000; sample++) {
    let text = "";
    const length = next() % 8;
    for (let index = 0; index < length; index++)
      text += pieces[next() % pieces.length];
    texts.push(text);
  }
  for (const text of texts)
    expect(decorated(scanComposerText(text)), JSON.stringify(text)).toEqual(
      decorated(scanMarkdown(text)),
    );
});

it("reuses the scan of unchanged text", () => {
  const text = "a `b` c";
  expect(scanComposerText(text)).toBe(scanComposerText(text));
});
