import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import remarkGfm from "remark-gfm";

/** GFM autolink literals make prose parse about twice as slow: micromark
 * tries an email literal at every word character. Every autolink literal
 * needs `@`, `www.` or `http(s)://`, and footnotes and task lists need
 * brackets. The autolink transform reads decoded text, where `\` escapes and
 * `&` references can produce that punctuation. Protection placeholders contain
 * none of these. */
const autolinkOrBracketSyntax = /[@&\\[\]]|www\.|https?:\/\//i;

type ParserData = {
  [key: string]: unknown;
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
};

/** The rest of remark-gfm, in its order, for content none of the others can apply to. */
function remarkGfmTablesAndStrikethrough(this: {
  data(): ParserData;
}): undefined {
  const data = this.data();
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    gfmStrikethrough(),
    gfmTable(),
  ];
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
  ];
}

export function remarkMessageGfm(content: string) {
  return autolinkOrBracketSyntax.test(content)
    ? remarkGfm
    : remarkGfmTablesAndStrikethrough;
}
