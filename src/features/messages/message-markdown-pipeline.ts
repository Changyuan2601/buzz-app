import {
  toJsxRuntime,
  type Components,
  type ExtraProps,
} from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

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

function transformUrls(parent: HastParent, urlTransform: UrlTransform) {
  for (const node of parent.children) {
    if (node.type !== "element") continue;
    for (const [key, tags] of Object.entries(urlAttributes))
      if (
        Object.hasOwn(node.properties, key) &&
        (tags === null || tags.includes(node.tagName))
      )
        node.properties[key] = urlTransform(String(node.properties[key] || ""));
    transformUrls(node, urlTransform);
  }
}

/** react-markdown with remark-gfm and `skipHtml`, without building a unified
 * processor per message: GFM parse, then the transforms in order, then
 * mdast-to-hast (which drops raw HTML), URL transform and React elements. */
export function renderMarkdown(
  content: string,
  transforms: readonly MarkdownTransform[],
  {
    components,
    urlTransform,
  }: { components: Components; urlTransform: UrlTransform },
): ReactElement {
  const tree = fromMarkdown(content, gfmSyntax);
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
