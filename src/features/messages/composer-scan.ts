import { scanMarkdown } from "../relay/message-content";

type ComposerScan = Pick<
  ReturnType<typeof scanMarkdown>,
  "tree" | "links" | "tooDeep"
>;

// Without these, CommonMark yields only paragraphs, text and emphasis: no
// code, image, definition, HTML or link node, and no nesting deep enough to
// trip the depth bound. Indented code needs four leading spaces.
const MARKDOWN_STRUCTURE = /[\n\r\t`~[<>*+-]|\d[.)]|^ {4}/;
const INERT: ComposerScan = {
  tree: { type: "root", children: [] },
  links: [],
  tooDeep: false,
};

let last: { text: string; scan: ComposerScan } | undefined;

/** The parts of a Markdown scan composer decorations read; read-only. Each
 * keystroke decorates the same text twice (normalizing the transaction, then
 * rendering), and plain prose has nothing to decorate from Markdown. */
export function scanComposerText(text: string): ComposerScan {
  if (!MARKDOWN_STRUCTURE.test(text)) return INERT;
  if (last?.text !== text) last = { text, scan: scanMarkdown(text) };
  return last.scan;
}
