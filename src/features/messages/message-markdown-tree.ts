import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";

// Collect exactly the syntax remark-gfm registers for MessageMarkdown's parser.
const syntax: {
  micromarkExtensions?: never[];
  fromMarkdownExtensions?: never[];
} = {};
remarkGfm.call({ data: () => syntax } as never);

/** The tree remark-parse builds for a message body under remark-gfm. */
export function parseMessageMarkdown(source: string): Root {
  return fromMarkdown(source, {
    extensions: syntax.micromarkExtensions ?? [],
    mdastExtensions: syntax.fromMarkdownExtensions ?? [],
  });
}
