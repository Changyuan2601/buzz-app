// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { expect, it, vi } from "vitest";
import { MessageMarkdown } from "./MessageMarkdown";
import { prepareMarkdown } from "./markdown-preparation";
import {
  preparedMarkdown,
  prepareMessageContents,
  takeMarkdownTree,
} from "./markdown-worker";
import { parseMessageMarkdown } from "./message-markdown-tree";

/** Runs the worker's work in-process and hands back structured clones. */
class PreparationWorker {
  onmessage?: (message: { data: unknown }) => void;
  onerror?: () => void;
  postMessage({ id, contents }: { id: number; contents: string[] }) {
    const results = contents.map((content) => {
      const prepared = prepareMarkdown(content);
      return {
        prepared,
        tree:
          prepared.kind === "markdown"
            ? parseMessageMarkdown(prepared.content)
            : undefined,
      };
    });
    setTimeout(() =>
      this.onmessage?.({ data: structuredClone({ id, results }) }),
    );
  }
  terminate() {}
}
vi.stubGlobal("Worker", PreparationWorker);

const mic = "b".repeat(64);
const corpus = [
  "plain prose without syntax",
  "Status: shipped\n\nSecond paragraph with *emphasis* and **strong**.",
  "See https://example.com/path?q=1 and [docs](https://docs.example.com).",
  "Ping @Mic about `inline code` and ~~old~~ news.",
  "- one\n  - nested `code`\n- two _em_\n\n1. ordered",
  "```ts\nconst x = 1;\n```",
  "> quoted *text* with ~struck~\n> second line",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "secret ||spoiler|| and \\||escaped||",
  "<b>raw</b> html <!-- comment --> text",
  "[ref]\n\n[ref]: https://example.com\n\n![alt](https://x.test/i.png)",
  "Footnote[^1].\n\n[^1]: note",
  "- [ ] task\n- [x] done",
  "&#58; entity &amp; www.example.com email@example.com",
  "https://wrapped.example.com/a\nb/c long link",
  "# Heading\nline one\nline two",
];

it("parses message bodies exactly as MessageMarkdown's remark parser does", () => {
  for (const source of corpus) {
    const trees: unknown[] = [];
    function capture(this: {
      parser?: ((document: string, file: never) => unknown) | undefined;
    }) {
      const parse = this.parser;
      this.parser = (document, file) => {
        const tree = parse?.(document, file);
        trees.push(structuredClone(tree));
        return tree;
      };
    }
    renderToStaticMarkup(
      <Markdown remarkPlugins={[capture, remarkGfm]}>{source}</Markdown>,
    );
    expect(parseMessageMarkdown(source), source).toEqual(trees[0]);
  }
});

it("renders worker-prepared bodies identically and consumes each tree once", async () => {
  const render = (content: string) =>
    renderToStaticMarkup(
      <MessageMarkdown
        row={{
          id: "message",
          channelId: "channel",
          authorId: "author",
          content,
          createdAt: 1,
          mentions: [mic],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        media={() => undefined}
        onOpenLink={() => false}
        canOpenLink={() => true}
        participantProfiles={new Map([[mic, { name: "Mic" }]])}
      />,
    );
  const expected = corpus.map(render);
  await prepareMessageContents(corpus);
  for (const content of corpus)
    expect(preparedMarkdown(content)).toEqual(prepareMarkdown(content));
  expect(corpus.map(render)).toEqual(expected);
  const source = corpus[1] ?? "";
  await prepareMessageContents([`${source} again`]);
  render(`${source} again`);
  expect(takeMarkdownTree(`${source} again`)).toBeUndefined();
  // A remount parses on the main thread again rather than reuse a mutated tree.
  expect(render(`${source} again`)).toBe(render(`${source} again`));
});
