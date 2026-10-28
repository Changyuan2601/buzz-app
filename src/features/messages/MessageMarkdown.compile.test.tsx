import Markdown, { type ExtraProps } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Components } from "hast-util-to-jsx-runtime";
import type { Profile } from "../relay/contracts";
import {
  compileMessageMarkdown,
  protectInlineContent,
  remarkInlineContent,
  remarkLiteralHtml,
  renderMessageMarkdown,
  transformUrl,
} from "./MessageMarkdown";
import { prepareMarkdown, scannedMarkdown } from "./markdown-preparation";
import { remarkSpoilers } from "./remark-spoilers";

const alice = "a".repeat(64),
  bob = "b".repeat(64);
const profiles = new Map<string, Profile>([
  [alice, { name: "Alice Fixture" }],
  [bob, { name: "Bob" }],
]);
const agents = [{ pubkey: bob, name: "Bob" }];
const emoji = [{ shortcode: "party", url: "https://emoji.test/party.png" }];

// Components see the hast node and props; serialize both so a difference in
// either, not just in the default HTML, fails the comparison.
const withoutPositions = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, entry) =>
      key === "position" ? undefined : entry,
    ),
  );
const probe = (tag: string) =>
  function Probe({
    node,
    children,
    ...props
  }: Record<string, unknown> & ExtraProps & { children?: ReactNode }) {
    const Tag = tag === "img" ? "span" : (tag as "span");
    return (
      <Tag
        data-probe-tag={tag}
        data-probe-node={JSON.stringify(withoutPositions(node))}
        data-probe-props={JSON.stringify(props)}
      >
        {children}
      </Tag>
    );
  };
const components: Components = Object.fromEntries(
  ["p", "a", "img", "span", "pre", "table", "code", "li", "input"].map(
    (tag) => [tag, probe(tag)],
  ),
);

/** react-markdown with the preparation and options MessageMarkdown rendered
 * through before bodies were compiled once. */
function reference(content: string) {
  const prepared = scannedMarkdown(content);
  if (prepared.kind === "plain") return undefined;
  const protectedContent = protect(prepared);
  return renderToStaticMarkup(
    <Markdown
      remarkPlugins={[
        remarkGfm,
        remarkBreaks,
        [remarkSpoilers, `<${protectedContent.prefix}spoiler\uE002>`],
        [remarkInlineContent, protectedContent],
        remarkLiteralHtml,
      ]}
      components={components}
      skipHtml
      urlTransform={transformUrl}
    >
      {protectedContent.content}
    </Markdown>,
  );
}

function compiled(content: string) {
  const prepared = prepareMarkdown(content);
  if (prepared.kind === "plain") return undefined;
  return renderToStaticMarkup(
    <>
      {renderMessageMarkdown(
        compileMessageMarkdown(protect(prepared)),
        components,
      )}
    </>,
  );
}

function protect(
  prepared: Extract<ReturnType<typeof prepareMarkdown>, { kind: "markdown" }>,
) {
  return protectInlineContent(
    {
      content: prepared.content,
      mentions: [alice, bob],
      mentionReferences: [],
      emoji,
    },
    profiles,
    () => prepared.literalRanges,
    agents,
    prepared.spoilerDelimiters,
  );
}

const corpus = [
  "Update: deploy 3 finished at 14:03, then the relay restarted.",
  "Plain prose.\nA second paragraph follows the blank line.",
  "Notes: https://example.com/notes/4 and [the design doc](https://example.com/design/4#history).",
  "@Alice Fixture can you check item 5? Thanks!",
  "Follow-ups:\n- update the fixture\n- rerun `bin/pnpm perf`\n  - compare **medians**",
  "Repro:\n```js\nconst page = await reader.read({ limit: 22 });\nconsole.log(page.length);\n```",
  "> Can we ship _this_ today?\n\n**Yes**, after ~~one more~~ review.",
  "Follow-ups:\n- [x] check the image\n- [ ] review the clip\n\n| Build | Style | Result |\n| --- | ---: | --- |\n| before | 120 ms | ready |\n| after | 80 ms | ready |",
  "||secret @Bob|| and ||**bold** spoiler|| plus | a || b |",
  "<b>typed html</b> <!-- hidden --> <!-- open",
  "<div>\nblock html\n</div>",
  "Footnote[^1].\n\n[^1]: The note with https://example.com",
  "![alt text](https://example.com/a.png) and ![](https://example.com/b.png)",
  "[ref][r] and [r]\n\n[r]: https://example.com/ref 'Title'",
  "nostr:npub1abc buzz://channel/design www.example.com a@b.co",
  "Encoded &#58; &#x40; &amp; &lt;tag&gt; https&#58;//evil.test",
  "Escapes \\*not\\* \\|\\| \\`code\\`",
  "[click](javascript:alert(1)) [mail](mailto:a@b.co) <https://auto.test/x_y>",
  ":party: :party:: and `:party:` in code",
  "1. one\n2. two\n   ```\n   nested fence\n   ```\n3. three",
  "Line one\nline two  \nline three\\\nline four",
  "# Heading\n\n## Sub *heading*\n\n---\n\nsetext\n===",
  "    indented code\n\n\tTabbed",
  "*a **b** c* _d __e__ f_ ~one~ ~~two~~",
  `${"> ".repeat(48)}nested quote`,
  `${"> ".repeat(101)}too deep`,
  `${"[".repeat(60)}link${"](https://x.test)".repeat(60)}`,
  `${"*".repeat(60)}deep emphasis${"*".repeat(60)}`,
];

const tokens = [
  "**",
  "*",
  "_",
  "__",
  "~~",
  "~",
  "`",
  "```\n",
  "||",
  "|",
  "[a](https://x.test/a_b)",
  "[",
  "]",
  "(",
  ")",
  "<b>",
  "</b>",
  "<!-- c -->",
  "<",
  ">",
  "> ",
  "- ",
  "* ",
  "1. ",
  "- [ ] ",
  "# ",
  "| a | b |\n| - | - |\n| 1 | 2 |\n",
  "\n",
  "\n\n",
  "  \n",
  "\\",
  "&#58;",
  "&#x40;",
  "&amp;",
  " ",
  "word",
  "Alice",
  "@Alice Fixture",
  "@Bob",
  ":party:",
  "#general",
  "[^1]",
  "\n[^1]: note\n",
  "![alt](https://x.test/y.png)",
  "https://example.com/a_b?c=d",
  "www.example.com",
  "a@b.co",
  "nostr:npub1qqqq",
  "buzz://channel/design",
  "",
  "",
  "￼",
  "&#xE000;",
  "\t",
];

function generated(count: number) {
  let seed = 0x2f6b9e;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  return Array.from({ length: count }, () =>
    Array.from(
      { length: 1 + Math.floor(random() * 24) },
      () => tokens[Math.floor(random() * tokens.length)],
    ).join(""),
  );
}

describe("compiled message Markdown", () => {
  it("renders exactly what react-markdown rendered for the corpus", () => {
    for (const content of corpus)
      expect(compiled(content), content).toBe(reference(content));
  });

  it("renders exactly what react-markdown rendered for generated input", () => {
    for (const content of generated(800))
      expect(compiled(content), JSON.stringify(content)).toBe(
        reference(content),
      );
  });

  it("prepares exactly what a full scan prepared", () => {
    for (const content of [...corpus, ...generated(800)]) {
      const prepared = prepareMarkdown(content);
      const scanned = scannedMarkdown(content);
      expect(
        prepared.kind === "plain"
          ? prepared
          : {
              kind: prepared.kind,
              content: prepared.content,
              literalRanges: prepared.literalRanges,
              spoilerDelimiters: prepared.spoilerDelimiters,
            },
        JSON.stringify(content),
      ).toEqual(scanned);
    }
  });

  it("returns a tree that renders the same every time", () => {
    for (const content of corpus) {
      const prepared = prepareMarkdown(content);
      if (prepared.kind === "plain") continue;
      const tree = compileMessageMarkdown(protect(prepared));
      const render = () =>
        renderToStaticMarkup(<>{renderMessageMarkdown(tree, components)}</>);
      expect(render()).toBe(render());
    }
  });
});
