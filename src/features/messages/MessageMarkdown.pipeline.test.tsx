import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { MessageMarkdown } from "./MessageMarkdown";

// Differential check: the frozen pipeline must render exactly what
// react-markdown rendered with remark-gfm, the same transforms, `skipHtml`
// and the same URL transform and components.
const legacy = vi.hoisted(() => ({ enabled: false }));
vi.mock("./message-markdown-pipeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./message-markdown-pipeline")>();
  return {
    ...actual,
    renderMarkdown: (...args: Parameters<typeof actual.renderMarkdown>) => {
      if (!legacy.enabled) return actual.renderMarkdown(...args);
      const [content, transforms, { components, urlTransform }] = args;
      return (
        <Markdown
          remarkPlugins={[
            remarkGfm,
            ...transforms.map((transform) => () => transform),
          ]}
          components={components}
          skipHtml
          urlTransform={urlTransform}
        >
          {content}
        </Markdown>
      );
    },
  };
});

const mic = "b".repeat(64);
const profiles = new Map([[mic, { name: "Mic" }]]);
function props(content: string): ComponentProps<typeof MessageMarkdown> {
  return {
    row: {
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
      emoji: [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    },
    media: () => undefined,
    onOpenLink: () => false,
    canOpenLink: () => true,
    participantProfiles: profiles,
  };
}
function both(content: string) {
  const render = (enabled: boolean) => {
    legacy.enabled = enabled;
    try {
      return renderToStaticMarkup(<MessageMarkdown {...props(content)} />);
    } finally {
      legacy.enabled = false;
    }
  };
  return { legacy: render(true), pipeline: render(false) };
}

const fragments = [
  "word",
  "Mixed height message content.",
  " ",
  "  ",
  "\t",
  "\n",
  "\n\n",
  "*",
  "**",
  "_",
  "__",
  "~",
  "~~",
  "`",
  "```js\n",
  "\n```",
  "[",
  "]",
  "](",
  ")",
  "(",
  "[label](https://example.com/a)",
  "![alt](https://example.com/i.png)",
  "<https://example.com>",
  "https://example.com/path?q=1",
  "http://x.test",
  "www.example.test",
  "WWW.example.test.",
  "user@example.test",
  "mailto:user@example.test",
  "buzz://channel/design",
  "nostr:npub1example",
  "||",
  "@Mic",
  "@Mic*",
  ":party:",
  ":unknown:",
  "> ",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "2) ",
  "- [ ] ",
  "- [x] ",
  "# ",
  "### ",
  "|",
  " | ",
  "\n--|--\n",
  "\n:-:|---\n",
  "\n:-\n",
  "\n-:\n",
  "\n: -\n",
  "a|b",
  "~a~",
  "HTTPS://x.test",
  "wWw.x.test",
  "\\@",
  "&#x40;",
  "&#119;ww.x.test",
  "---",
  "<b>",
  "</b>",
  "<!-- hidden -->",
  "<!--",
  "&#64;",
  "&amp;",
  "&#58;",
  "&#x2e;",
  "\\",
  "\\*",
  "\\|",
  "[^1]",
  "\n\n[^1]: note",
  "[ref]",
  "\n\n[ref]: https://example.com/ref",
  "    indented",
  "\r\n",
  "",
  "￼",
  "é",
  "🎉",
  "1",
  ".",
  ",",
  ":",
  "!",
];

/** Deterministic xorshift, so a failure names a reproducible seed. */
function generator(seed: number) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const fixture = [
  "",
  "Update: deploy 3 finished at 14:03, then the relay restarted.",
  "\nA second paragraph follows the blank line.",
  "Notes: https://example.com/notes/3 and [the design doc](https://example.com/design/3#history).",
  "@Mic can you check item 4? Thanks!",
  "Follow-ups:\n- update the fixture\n- rerun `bin/pnpm perf`\n  - compare **medians**",
  "Repro:\n```js\nconst page = await reader.read({ limit: 21 });\nconsole.log(page.length);\n```",
  "> Can we ship _this_ today?\n\n**Yes**, after ~~one more~~ review.",
].map(
  (syntax, i) =>
    `primary general message ${i}\n${"Mixed height message content. ".repeat(1 + i * 3)}${syntax ? `\n${syntax}` : ""}`,
);

describe("message Markdown pipeline", () => {
  it.each(fixture.map((content, index) => [index, content]))(
    "renders fixture body %i exactly as react-markdown",
    (_index, content) => {
      const { legacy, pipeline } = both(content as string);
      expect(pipeline).toBe(legacy);
    },
  );

  it("renders generated Markdown exactly as react-markdown", () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const random = generator(seed);
      const length = 1 + Math.floor(random() * 24);
      let content = "";
      for (let index = 0; index < length; index++)
        content += fragments[Math.floor(random() * fragments.length)];
      const { legacy, pipeline } = both(content);
      expect({ seed, content, html: pipeline }).toEqual({
        seed,
        content,
        html: legacy,
      });
    }
  });
});
