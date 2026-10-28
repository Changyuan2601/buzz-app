import {
  toJsxRuntime,
  type Components,
  type ExtraProps,
} from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { takeScannedMarkdown } from "./markdown-preparation";

export type { Components, ExtraProps };
export type MarkdownTransform = (tree: Root) => void;
export type UrlTransform = (url: string) => string | null | undefined;
type HastParent = Extract<
  ReturnType<typeof toHast>,
  { type: "root" | "element" }
>;

/** GFM syntax is configuration, so build it once for every message. */
const gfmSyntax = {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
};
const strikethrough = {
  extensions: [gfmStrikethrough()],
  mdastExtensions: [gfmStrikethroughFromMarkdown()],
};
const table = {
  extensions: [gfmTable()],
  mdastExtensions: [gfmTableFromMarkdown()],
};
/** remark-gfm's order: strikethrough before table. Indexed by
 * `strikethrough + 2 * table`. */
const gfmSubsets = [[], [strikethrough], [table], [strikethrough, table]].map(
  (parts) => ({
    extensions: parts.flatMap((part) => part.extensions),
    mdastExtensions: parts.flatMap((part) => part.mdastExtensions),
  }),
);

/** GFM autolink literals make prose parse about twice as slow: micromark
 * tries a literal at every word character. Every autolink literal needs `@`,
 * `www.` or `http(s)://`, and footnotes and task lists need brackets. The
 * autolink transform reads decoded text, where `\` escapes and `&` references
 * can produce that punctuation. Without any of these, only strikethrough
 * (`~`) and tables (a pipe, or a colon beside a dash in the delimiter row)
 * can apply, and each is loaded only when its syntax can occur. */
const autolinkOrBracketSyntax = /[@&\\[\]]|www\.|https?:\/\//i;
const tableSyntax = /\||:-|-:/;

function gfmSyntaxFor(content: string) {
  if (autolinkOrBracketSyntax.test(content)) return gfmSyntax;
  return gfmSubsets[
    (content.includes("~") ? 1 : 0) + (tableSyntax.test(content) ? 2 : 0)
  ] as (typeof gfmSubsets)[number];
}

const urlAttributeTags = Object.entries(urlAttributes);

function transformUrls(parent: HastParent, urlTransform: UrlTransform) {
  for (const node of parent.children) {
    if (node.type !== "element") continue;
    for (const [key, tags] of urlAttributeTags)
      if (
        Object.hasOwn(node.properties, key) &&
        (tags === null || tags.includes(node.tagName))
      )
        node.properties[key] = urlTransform(String(node.properties[key] || ""));
    transformUrls(node, urlTransform);
  }
}

/** react-markdown with remark-gfm and `skipHtml`, without building a unified
 * processor per message: GFM parse (limited to the constructs the content can
 * hold, and shared with prepareMarkdown when that is none), then the transforms in order, then
 * mdast-to-hast (which drops raw HTML), URL transform and React elements. */
export function renderMarkdown(
  content: string,
  transforms: readonly MarkdownTransform[],
  {
    components,
    urlTransform,
  }: { components: Components; urlTransform: UrlTransform },
): ReactElement {
  const syntax = gfmSyntaxFor(content);
  // Without any GFM syntax this is the CommonMark parse prepareMarkdown made.
  const tree =
    (syntax === gfmSubsets[0] &&
      (takeScannedMarkdown(content) as Root | undefined)) ||
    fromMarkdown(content, syntax);
  for (const transform of transforms) transform(tree);
  const hast = toHast(tree);
  if (hast.type === "root" || hast.type === "element")
    transformUrls(hast, urlTransform);
  return toJsxRuntime(hast, {
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  });
}
