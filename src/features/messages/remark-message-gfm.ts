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
    ...(strikethrough ? [gfmStrikethrough()] : []),
    ...(table ? [gfmTable()] : []),
  ];
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    ...(strikethrough ? [gfmStrikethroughFromMarkdown()] : []),
    ...(table ? [gfmTableFromMarkdown()] : []),
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
