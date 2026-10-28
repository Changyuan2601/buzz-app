import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import {
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_LENGTH,
  scanMarkdown,
} from "../relay/message-content";
import { normalizeWrappedLinks } from "./message-link-parts";

export type LiteralRange = Readonly<{ start: number; end: number }>;
type MarkdownNode = {
  type: string;
  children?: MarkdownNode[] | undefined;
  position?:
    | {
        start: { offset?: number | undefined };
        end: { offset?: number | undefined };
      }
    | undefined;
};
export type PreparedMarkdown =
  | Readonly<{ kind: "plain"; content: string }>
  | Readonly<{
      kind: "markdown";
      content: string;
      literalRanges: readonly LiteralRange[];
      spoilerDelimiters: readonly number[];
    }>;

export const isLiteralMarkdownContext = (type: string) =>
  [
    "code",
    "inlineCode",
    "link",
    "linkReference",
    "image",
    "imageReference",
    "definition",
    "html",
  ].includes(type);

function literalRanges(
  tree: MarkdownNode,
  includeLinks: boolean,
): readonly LiteralRange[] {
  const ranges: LiteralRange[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (
      isLiteralMarkdownContext(node.type) &&
      (includeLinks || node.type !== "link")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        ranges.push(Object.freeze({ start, end }));
      continue;
    }
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
      const child = node.children?.[index];
      if (child) pending.push(child);
    }
  }
  return Object.freeze(ranges);
}

function spoilerDelimiters(content: string): readonly number[] {
  if (!content.includes("||")) return Object.freeze([]);
  // Table separators are grammar, not prose. Reuse the same GFM table parser
  // as the renderer without enabling autolinks, which can consume closing pipes.
  const tree = fromMarkdown(content, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const positions: number[] = [];
  const visit = (node: MarkdownNode) => {
    if (isLiteralMarkdownContext(node.type) || node.type === "table") return;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) {
      for (const match of content.slice(start, end).matchAll(/\\[\s\S]|\|\|/g))
        if (match[0] === "||") positions.push(start + match.index);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return Object.freeze(positions);
}

/** scanMarkdown parses CommonMark without extensions, where every literal
 * context, container and emphasis needs one of these characters or a line
 * starting with indentation or a list marker. micromark drops a leading BOM,
 * which would hide the first line's start. Without them a scan finds no literal
 * ranges, nothing to normalize, and no nesting below paragraphs. */
const scannedSyntax = /[`~[<>*_\uFEFF]|^[ \t+\-\d]/m;

/** Below a root and its paragraph or heading, every CommonMark parent needs
 * one of these: a blockquote `>`, a list marker (for a list and its item),
 * emphasis, or a link label. */
const nestingSyntax = /[>*_+\-\d[]/g;

function withinDepthBound(content: string) {
  let parents = 0;
  for (const _ of content.matchAll(nestingSyntax)) {
    parents += 2;
    if (parents + 2 > MAX_MARKDOWN_DEPTH) return false;
  }
  return true;
}

/** Pure, immutable Markdown work whose lifetime is owned by the mounted body. */
export function prepareMarkdown(content: string): PreparedMarkdown {
  if (content.length > MAX_MARKDOWN_LENGTH)
    return Object.freeze({ kind: "plain", content });
  if (!scannedSyntax.test(content))
    return Object.freeze({
      kind: "markdown",
      content,
      literalRanges: Object.freeze([]),
      spoilerDelimiters: spoilerDelimiters(content),
    });

  // Normalization needs one of these, and short syntax cannot reach the depth
  // guard. Only bound names, emoji, entities and spoilers read literal ranges,
  // so scan for them on first use.
  if (
    !content.includes("]\\(") &&
    !content.includes("]([") &&
    withinDepthBound(content)
  ) {
    let ranges: readonly LiteralRange[] | undefined;
    return Object.freeze({
      kind: "markdown",
      content,
      get literalRanges() {
        if (!ranges) ranges = literalRanges(scanMarkdown(content).tree, true);
        return ranges;
      },
      spoilerDelimiters: spoilerDelimiters(content),
    });
  }

  let scan = scanMarkdown(content);
  if (scan.tooDeep) return Object.freeze({ kind: "plain", content });

  const normalizationLiterals = literalRanges(scan.tree, false);
  const normalized = normalizeWrappedLinks(content, (start, end) =>
    normalizationLiterals.some(
      (range) => start < range.end && end > range.start,
    ),
  );
  if (normalized !== content) {
    scan = scanMarkdown(normalized);
    if (scan.tooDeep) return Object.freeze({ kind: "plain", content });
  }

  return Object.freeze({
    kind: "markdown",
    content: normalized,
    literalRanges: literalRanges(scan.tree, true),
    spoilerDelimiters: spoilerDelimiters(normalized),
  });
}
