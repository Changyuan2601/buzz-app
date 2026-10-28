import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";

/** GFM autolink literals make prose parse about twice as slow: micromark
 * tries an email literal at every word character. Every autolink literal
 * needs `@`, `www.` or `http(s)://`, and footnotes and task lists need
 * brackets. The autolink transform reads decoded text, where `\` escapes and
 * `&` references can produce that punctuation. Protection placeholders contain
 * none of these. */
const autolinkOrBracketSyntax = /[@&\\[\]]|www\.|https?:\/\//i;
/** A table's delimiter row needs a pipe or a colon beside a dash. */
const tableSyntax = /\||:-|-:/;

/** Built once, like remark-gfm's own default extensions, so micromark can
 * reuse the constructs it combined for the same extension list. */
const strikethroughExtensions = [
  gfmStrikethrough(),
  gfmStrikethroughFromMarkdown(),
] as const;
const tableExtensions = [gfmTable(), gfmTableFromMarkdown()] as const;

type ParserData = {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
};

/** The rest of remark-gfm, in its order, limited to constructs the content can hold. */
function remarkGfmSubset(
  this: { data(): object },
  { strikethrough, table }: { strikethrough: boolean; table: boolean },
): undefined {
  const data: ParserData = this.data();
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    ...(strikethrough ? [strikethroughExtensions[0]] : []),
    ...(table ? [tableExtensions[0]] : []),
  ];
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    ...(strikethrough ? [strikethroughExtensions[1]] : []),
    ...(table ? [tableExtensions[1]] : []),
  ];
}

export function remarkMessageGfm(
  content: string,
): NonNullable<Options["remarkPlugins"]>[number] {
  return autolinkOrBracketSyntax.test(content)
    ? remarkGfm
    : [
        remarkGfmSubset,
        {
          strikethrough: content.includes("~"),
          table: tableSyntax.test(content),
        },
      ];
}
