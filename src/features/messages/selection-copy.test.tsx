// @vitest-environment jsdom
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import { npubEncode } from "nostr-tools/nip19";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyEmoji } from "../../bundled/emoji/copy-emoji";
import { profileTarget } from "../profiles/target";
import { MessageMarkdown } from "./MessageMarkdown";
import {
  type CopyFormat,
  serializeNode,
  serializeSelection,
  useMessageSelectionCopy,
} from "./selection-copy";

const person = "a".repeat(64);
const target = `nostr:${npubEncode(person)}`;
const message = `buzz://message?channel=general&id=${"b".repeat(64)}`;
const messageHtml = message.replaceAll("&", "&amp;");
const formats: CopyFormat[] = ["text", "markdown", "html"];

// Markup shapes produced by MessageMarkdown's renderProfile and MessageLink.
const mention = (name = "Morgan", locator = target) =>
  `<button type="button" data-mention-kind="person" data-profile-target="${locator}" data-mention-name="${name}"><svg aria-hidden="true"><path d="M0 0"></path></svg>${name}</button>`;
const anchor = (href: string, label: string, visible = label) =>
  `<a href="${href}" data-link-label="${label}"><span data-link-kind="web"><span class="lead"><svg aria-hidden="true"></svg>${visible}</span></span></a>`;
const row = (html: string, id = "m1") =>
  `<div data-message-id="${id}">${html}</div>`;

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body;
}
function query(selector: string, root: ParentNode = document) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
function lastText(node: Node): Text {
  const last = node.lastChild;
  if (!last) throw new Error("Empty node");
  return last.nodeType === Node.TEXT_NODE ? (last as Text) : lastText(last);
}
function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection();
  if (!selection) throw new Error("No selection");
  selection.removeAllRanges();
  selection.addRange(range);
  return { range, selection };
}
function each(node: Node, range?: Range) {
  return Object.fromEntries(
    formats.map((format) => [format, serializeNode(node, format, range)]),
  ) as Record<CopyFormat, string>;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("serializeNode", () => {
  it.each([
    [mention(), "Morgan", "@Morgan", `[@Morgan](${target})`],
    [
      anchor("buzz://channel/design", "#design", "design"),
      "design",
      "#design",
      "[#design](buzz://channel/design)",
    ],
    [
      anchor("http://example.com/docs", "docs"),
      "docs",
      "docs (http://example.com/docs)",
      "[docs](http://example.com/docs)",
    ],
    [
      anchor("https://example.com/docs", "docs"),
      "docs",
      "docs (https://example.com/docs)",
      "[docs](https://example.com/docs)",
    ],
  ])(
    "keeps a whole chip selected within one text node: %s",
    (html, label, plain, markdown) => {
      const paragraph = query("p", mount(row(`<p>before ${html} after</p>`)));
      const labelNode = lastText(query("button, a", paragraph));
      const { selection } = select(labelNode, 0, labelNode, label.length);
      expect(serializeSelection(selection, "text")).toBe(plain);
      expect(serializeSelection(selection, "markdown")).toBe(markdown);
      expect(serializeSelection(selection, "html")).toContain("<a href=");
      select(labelNode, 1, labelNode, label.length - 1);
      for (const format of formats)
        expect(serializeSelection(selection, format)).toBe(label.slice(1, -1));
    },
  );

  it("keeps a whole mention's identity and drops it from a fragment", () => {
    const paragraph = query("p", mount(row(`<p>Hi ${mention()} there</p>`)));
    expect(each(paragraph)).toEqual({
      text: "Hi @Morgan there",
      markdown: `Hi [@Morgan](${target}) there`,
      html: `<p>Hi <a href="${target}">@Morgan</a> there</p>`,
    });
    const { range } = select(
      paragraph.firstChild as Node,
      0,
      lastText(query("button", paragraph)),
      3,
    );
    expect(each(paragraph, range)).toEqual({
      text: "Hi Mor",
      markdown: "Hi Mor",
      html: "<p>Hi Mor</p>",
    });
    const whole = select(
      paragraph.firstChild as Node,
      3,
      lastText(query("button", paragraph)),
      6,
    );
    expect(serializeNode(paragraph, "markdown", whole.range)).toBe(
      `[@Morgan](${target})`,
    );
  });

  it("restores the channel sigil with its locator", () => {
    const link = query(
      "a",
      mount(row(anchor("buzz://channel/design", "#design", "design"))),
    );
    expect(each(link)).toEqual({
      text: "#design",
      markdown: "[#design](buzz://channel/design)",
      html: '<a href="buzz://channel/design">#design</a>',
    });
  });

  it("copies raw in-app and external links as their URL and labelled ones with the label", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>${anchor(message, "", "Message")} ${anchor(message, "Desktop alias")} ${anchor("https://example.com/docs", "", "example.com/docs")} ${anchor("https://example.com/docs", "docs")}</p>`,
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: `${message} Desktop alias (${message}) https://example.com/docs docs (https://example.com/docs)`,
      markdown: `${message} [Desktop alias](${message}) https://example.com/docs [docs](https://example.com/docs)`,
      html: `<p><a href="${messageHtml}">${messageHtml}</a> <a href="${messageHtml}">Desktop alias</a> <a href="https://example.com/docs">https://example.com/docs</a> <a href="https://example.com/docs">docs</a></p>`,
    });
    const { range } = select(
      lastText(query("a:nth-of-type(2)", paragraph)),
      0,
      lastText(query("a:nth-of-type(2)", paragraph)),
      7,
    );
    expect(serializeNode(paragraph, "markdown", range)).toBe("Desktop");
  });

  it("copies labelled and shortened raw HTTP links through every clipboard format", () => {
    const raw = "http://example.com/a/long/destination";
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>${anchor(raw, "", "example.com/a/long…")} ${anchor("http://example.com/docs", "docs")}</p>`,
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: `${raw} docs (http://example.com/docs)`,
      markdown: `${raw} [docs](http://example.com/docs)`,
      html: `<p><a href="${raw}">${raw}</a> <a href="http://example.com/docs">docs</a></p>`,
    });
    const template = document.createElement("template");
    template.innerHTML = serializeNode(paragraph, "html");
    expect(serializeNode(template.content, "markdown")).toBe(
      serializeNode(paragraph, "markdown"),
    );
  });

  it("reads its own HTML back into the same Markdown", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>Ask ${mention()} in ${anchor("buzz://channel/design", "#design", "design")} about <strong>${anchor("https://example.com/", "", "example.com")}</strong> or ${anchor(message, "Desktop alias")}</p>`,
        ),
      ),
    );
    const template = document.createElement("template");
    template.innerHTML = serializeNode(paragraph, "html");
    expect(serializeNode(template.content, "markdown")).toBe(
      serializeNode(paragraph, "markdown"),
    );
    expect(serializeNode(template.content, "text")).toBe(
      serializeNode(paragraph, "text"),
    );
  });

  it.each(["", "\n", "\n\n\n"])(
    "drops renderer whitespace between paragraphs with DOM separator %j",
    (spacing) => {
      const body = mount(row(`<p>First</p>${spacing}<p>Second</p>`));
      const { selection } = select(
        lastText(query("p", body)),
        1,
        lastText(query("p:last-child", body)),
        3,
      );
      expect(serializeSelection(selection, "text")).toBe("irst\n\nSec");
      const html = document.createElement("div");
      html.dataset.buzzCopy = "timeline";
      html.innerHTML = serializeSelection(selection, "html");
      expect(serializeNode(html, "markdown")).toBe("irst\n\nSec");
    },
  );

  it("writes custom emoji as shortcodes", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          '<p>Party <img data-copy-emoji=":party:" alt=":party:" src="x"> on <img alt="plain" src="y"></p>',
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: "Party :party: on ",
      markdown: "Party :party: on ",
      html: "<p>Party :party: on </p>",
    });
  });

  it("separates rows and blocks like the browser's plain text", () => {
    const body = mount(
      `<ol><li>${row("<p>First</p>")}</li><li>${row(`<p>Second ${mention()}</p><table><tr><td>a</td><td></td><td>c</td></tr></table>`, "m2")}</li></ol>`,
    );
    const { selection } = select(
      lastText(query("[data-message-id='m1'] p", body)),
      0,
      lastText(query("td:last-child", body)),
      1,
    );
    expect(serializeSelection(selection, "text")).toBe(
      "First\nSecond @Morgan\n\na\t\tc",
    );
    expect(serializeSelection(selection, "markdown")).toBe(
      `First\nSecond [@Morgan](${target})\na\t\tc`,
    );
    expect(serializeSelection(selection, "html")).toBe(
      `<p>First</p><p>Second <a href="${target}">@Morgan</a></p><table><tbody><tr><td>a</td><td></td><td>c</td></tr></tbody></table>`,
    );
  });

  it.each([
    [2, "a\tb"],
    [4, "a\tb\nc\td"],
  ])(
    "keeps table boundaries when the selection ends in cell %s",
    (end, expected) => {
      const body = mount(
        row(
          "<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>",
        ),
      );
      const cells = body.querySelectorAll("td");
      const { selection } = select(
        lastText(cells.item(0)),
        0,
        lastText(cells.item(end - 1)),
        1,
      );
      expect(serializeSelection(selection, "text")).toBe(expected);
      expect(serializeSelection(selection, "markdown")).toBe(expected);
      const html = document.createElement("template");
      html.innerHTML = `<div data-buzz-copy="timeline">${serializeSelection(selection, "html")}</div>`;
      expect(serializeNode(html.content, "markdown")).toBe(expected);
    },
  );

  it("keeps inline formatting, code and fenced blocks", () => {
    const body = mount(
      row(
        '<p><strong>bold</strong> <em>it</em> <s>gone</s> <code>ls</code><br>next</p>\n<pre><code class="language-sh">echo hi\nls</code></pre>',
      ),
    );
    expect(each(query("[data-message-id]", body))).toEqual({
      text: "bold it gone ls\nnext\n\necho hi\nls",
      markdown: "**bold** _it_ ~~gone~~ `ls`\nnext\n\n```sh\necho hi\nls\n```",
      html: '<p><strong>bold</strong> <em>it</em> <s>gone</s> <code>ls</code><br>next</p><pre><code class="language-sh">echo hi\nls</code></pre>',
    });
  });

  it("keeps whitespace outside emphasis delimiters and inside code", () => {
    const paragraph = query(
      "p",
      mount(
        row("<p>a<strong> bold </strong>b <em>it </em>c <code> ls </code></p>"),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: "a bold b it c  ls ",
      markdown: "a **bold** b _it_ c `  ls  `",
      html: "<p>a<strong> bold </strong>b <em>it </em>c <code> ls </code></p>",
    });
  });

  it.each([
    [1, "a"],
    [2, "a\n"],
    [3, "a\nb"],
    [4, "a\nb"],
  ])(
    "keeps selected code content at offset %s while removing only its terminator",
    (end, value) => {
      const body = mount(row("<p>x</p><pre><code>a\nb\n</code></pre>"));
      const { selection } = select(
        lastText(query("p", body)),
        0,
        lastText(query("code", body)),
        end,
      );
      const expected = `x\n\n\`\`\`\n${value}\n\`\`\``;
      expect(serializeSelection(selection, "markdown")).toBe(expected);
      const html = document.createElement("template");
      html.innerHTML = serializeSelection(selection, "html");
      expect(serializeNode(html.content, "markdown")).toBe(expected);
    },
  );

  it("writes lists, quotes and fences as Markdown blocks", () => {
    // Renderer formatting whitespace is omitted; semantic blocks own separation.
    const body = mount(
      row(
        '<ul><li>one</li><li>two <strong>b</strong></li></ul>\n<ol start="3"><li><p>first</p>\n<ul><li>sub</li></ul></li></ol>\n<blockquote><p>quoted</p>\n<blockquote><p>deep</p></blockquote></blockquote>\n<pre data-language="sh"><code>ls</code></pre>',
      ),
    );
    expect(each(query("[data-message-id]", body))).toEqual({
      text: "one\ntwo b\n\nfirst\n\nsub\n\nquoted\n\ndeep\n\nls",
      markdown:
        "- one\n- two **b**\n\n3. first\n   \n   - sub\n\n> quoted\n>\n> > deep\n\n```sh\nls\n```",
      html: '<ul><li>one</li><li>two <strong>b</strong></li></ul><ol start="3"><li><p>first</p><ul><li>sub</li></ul></li></ol><blockquote><p>quoted</p><blockquote><p>deep</p></blockquote></blockquote><pre><code class="language-sh">ls</code></pre>',
    });
    // A partial selection keeps each item's own number.
    const { range } = select(
      lastText(query("ol li p", body)),
      2,
      lastText(query("blockquote p", body)),
      3,
    );
    expect(
      serializeNode(query("[data-message-id]", body), "markdown", range),
    ).toBe("3. rst\n   \n   - sub\n\n> quo");
  });

  it("degrades unknown elements to text and escapes HTML", () => {
    const paragraph = query(
      "p",
      mount(row('<p><mark>PLUGIN</mark> &lt;tag&gt; &amp; "q"</p>')),
    );
    expect(each(paragraph)).toEqual({
      text: 'PLUGIN <tag> & "q"',
      markdown: 'PLUGIN <tag> & "q"',
      html: "<p>PLUGIN &lt;tag&gt; &amp; &quot;q&quot;</p>",
    });
  });

  it("escapes link labels read from the DOM", () => {
    const markup = '"><img src=x onerror=alert(1)>';
    const html = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;";
    const markdown = '"\\>\\<img src=x onerror=alert(1)\\>';
    const paragraph = query(
      "p",
      mount(row(`<p>${mention()} ${mention()} ${anchor(message, "docs")}</p>`)),
    );
    // Each label source: a mention name, a nameless chip's text, a link label.
    query("button", paragraph).setAttribute("data-mention-name", markup);
    const chip = query("button:nth-of-type(2)", paragraph);
    chip.removeAttribute("data-mention-name");
    lastText(chip).data = markup;
    query("a", paragraph).setAttribute("data-link-label", markup);
    expect(each(paragraph)).toEqual({
      text: `@${markup} @${markup} ${markup} (${message})`,
      markdown: `[@${markdown}](${target}) [@${markdown}](${target}) [${markdown}](${message})`,
      html: `<p><a href="${target}">@${html}</a> <a href="${target}">@${html}</a> <a href="${messageHtml}">${html}</a></p>`,
    });
  });

  it("emits unsafe or unverifiable destinations as text only", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>${anchor("javascript:alert(1)", "x")} ${anchor("http://user:pw@example.com/", "plain")} ${anchor("https://user:pw@example.com/", "", "example.com")} ${anchor("buzz://channel/bad id", "#bad")} ${mention("Spoof", "nostr:npub1invalid")} ${mention("Agent", `buzz:agent-profile:${person}`)}</p>`,
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: "x plain example.com #bad Spoof Agent",
      markdown: "x plain example.com #bad Spoof Agent",
      html: "<p>x plain example.com #bad Spoof Agent</p>",
    });
  });
});

describe("useMessageSelectionCopy", () => {
  const mic = "c".repeat(64);
  function Surface() {
    useMessageSelectionCopy();
    return null;
  }
  function copy(
    node: Node,
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ) {
    select(start, startOffset, end, endOffset);
    const setData = vi.fn();
    const event = createEvent.copy(node, { clipboardData: { setData } });
    fireEvent(node, event);
    return { prevented: event.defaultPrevented, data: setData.mock.calls };
  }

  it("writes both flavors for a rendered message and nothing for an editor", () => {
    const view = render(
      <StrictMode>
        <Surface />
        <div data-message-id="m1">
          <MessageMarkdown
            row={{
              id: "m1",
              channelId: "general",
              authorId: mic,
              content: `Hi @Mic, see #design and https://example.com/docs, ${message} or [Alias](${message})`,
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
            directory={{
              profiles: new Map(),
              agents: [],
              channels: [
                { id: "design", name: "design", channelType: "forum" },
                { id: "general", name: "General", channelType: "forum" },
              ],
            }}
          />
        </div>
        <div contentEditable="true" suppressContentEditableWarning>
          <p>draft @Mic</p>
        </div>
      </StrictMode>,
    );
    // The raw message link shows its channel's name but copies as its URL.
    expect(view.getByRole("link", { name: "General" }).textContent).toBe(
      "General",
    );
    const paragraph = query("[data-message-id] p", view.container);
    expect(
      copy(paragraph, paragraph, 0, paragraph, paragraph.childNodes.length),
    ).toEqual({
      prevented: true,
      data: [
        [
          "text/plain",
          `Hi @Mic, see #design and https://example.com/docs, ${message} or Alias (${message})`,
        ],
        [
          "text/html",
          `<div data-buzz-copy="timeline"><p>Hi <a href="${profileTarget(mic)}">@Mic</a>, see <a href="buzz://channel/design">#design</a> and <a href="https://example.com/docs">https://example.com/docs</a>, <a href="${messageHtml}">${messageHtml}</a> or <a href="${messageHtml}">Alias</a></p></div>`,
        ],
      ],
    });
    const draft = query("[contenteditable] p", view.container);
    expect(copy(draft, draft, 0, draft, 1)).toEqual({
      prevented: false,
      data: [],
    });
  });

  it("acts before the emoji plugin for messages and leaves other selections to it", () => {
    document.addEventListener("copy", copyEmoji);
    try {
      const view = render(
        <StrictMode>
          <Surface />
        </StrictMode>,
      );
      document.body.insertAdjacentHTML(
        "beforeend",
        `${row('<p>Party <img data-copy-emoji=":party:" alt=":party:" src="x"> on</p>')}<div><p>Outside <img data-copy-emoji=":party:" alt=":party:" src="x"></p></div>`,
      );
      const inside = query("[data-message-id] p");
      expect(copy(inside, inside, 0, inside, 3)).toEqual({
        prevented: true,
        data: [
          ["text/plain", "Party :party: on"],
          [
            "text/html",
            '<div data-buzz-copy="timeline"><p>Party :party: on</p></div>',
          ],
        ],
      });
      const outside = query("body > div:not([data-message-id]) p");
      expect(copy(outside, outside, 0, outside, 2)).toEqual({
        prevented: true,
        data: [["text/plain", "Outside :party:"]],
      });
      // The listener is shared: it outlives one surface and leaves with the last.
      const second = render(<Surface />);
      view.unmount();
      expect(copy(inside, inside, 0, inside, 3).data).toHaveLength(2);
      second.unmount();
      expect(copy(inside, inside, 0, inside, 3)).toEqual({
        prevented: true,
        data: [["text/plain", "Party :party: on"]],
      });
    } finally {
      document.removeEventListener("copy", copyEmoji);
    }
  });
});
