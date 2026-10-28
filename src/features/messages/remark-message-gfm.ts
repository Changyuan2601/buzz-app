import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";

/** micromark's GFM autolink literal extension tries an email literal at every
 * word character. Every autolink literal needs `@`, `www.` or `http(s)://`,
 * and the autolink transform reads decoded text, where `\` escapes and `&`
 * references can produce that punctuation. Brackets keep footnotes and task
 * lists on the full path too: without brackets they match nothing, and the
 * subset needs no packages beyond the direct strikethrough and table ones.
 * Protection placeholders contain none of these. */
const autolinkOrBracketSyntax = /[@&\\[\]]|www\.|https?:\/\//i;
/** The table extension tries a head row at every flow start and paragraph
 * continuation line; its delimiter row needs a pipe or a colon beside a dash. */
const tableSyntax = /\||:-|-:/;

type ParserData = {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
};

/** remark-gfm 4.0.1's strikethrough and table, in its order and with its
 * defaults. The direct pins must match remark-gfm's own on upgrade. */
function remarkGfmSubset(
  this: { data(): object },
  { table }: { table: boolean },
): undefined {
  const data: ParserData = this.data();
  data.micromarkExtensions ??= [];
  data.fromMarkdownExtensions ??= [];
  data.micromarkExtensions.push(gfmStrikethrough());
  data.fromMarkdownExtensions.push(gfmStrikethroughFromMarkdown());
  if (table) {
    data.micromarkExtensions.push(gfmTable());
    data.fromMarkdownExtensions.push(gfmTableFromMarkdown());
  }
}

export function remarkMessageGfm(
  content: string,
): NonNullable<Options["remarkPlugins"]>[number] {
  return autolinkOrBracketSyntax.test(content)
    ? remarkGfm
    : [remarkGfmSubset, { table: tableSyntax.test(content) }];
}
