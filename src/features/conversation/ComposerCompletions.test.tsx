// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCompletions } from "./ComposerCompletions";
import type { CompletionEditor } from "./useCompletionEditor";
import type { ComposerCompletion, ComposerCompletionProps } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import type { RelaySession } from "../relay/session";
import type { ComposerInputElement } from "../messages/composer-dom";
import type { ComposerSnapshot } from "../messages/mention-draft";
import { channelQuery } from "../../bundled/channels/channel-query";
import * as markdown from "../relay/message-content";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const providers: Contribution<ComposerCompletion>[] = [
  {
    id: "channel-typeahead",
    key: "buzz.channels/channel-typeahead",
    pluginId: "buzz.channels",
    revision: "1",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: () => <span>Channel provider mounted</span>,
  },
];
function mount(text: string, caret = text.length, document?: ComposerSnapshot) {
  const editor = {
    observation: { revision: 1, text, start: caret, end: caret },
    valid: () => true,
    observe: () => {},
    settle: () => {},
    invalidate: () => {},
    keys: { current: undefined },
    composing: { current: false },
  } as CompletionEditor;
  return render(
    <ComposerCompletions
      registry={{ snapshot: () => providers, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: null as ComposerInputElement | null }}
      replace={() => true}
      resolved={{ text, recipients: [], ...(document ? { document } : {}) }}
      session={{} as RelaySession}
      scope="test"
      channelId="c"
    />,
  );
}
it.each(["#", "prose #we", "## Heading #we", "> #we", "- #we"])(
  "allows prose: %s",
  (text) => {
    mount(text);
    expect(screen.queryByText("Channel provider mounted")).not.toBeNull();
  },
);
it.each([
  ["`code #we`", 9],
  ["```\n#we\n```", 7],
  ["    #we", 7],
  ["[label #we](https://example.test)", 10],
  ["![alt #we](https://example.test)", 9],
  ["[label #we][ref]\n\n[ref]: https://example.test", 10],
  ["<span>\n#we\n</span>", 10],
  ["[ref]: https://example.test (#we)", 30],
] as const)("does not mount inside raw code/links/HTML: %s", (text, caret) => {
  mount(text, caret);
  expect(screen.queryByText("Channel provider mounted")).toBeNull();
});
it.each(["code", "link", "literal"])(
  "does not mount in rich %s marks",
  (mark) => {
    mount("#we", 3, {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "#we",
                marks: [
                  {
                    type: mark,
                    ...(mark === "link"
                      ? { attrs: { href: "https://example.test" } }
                      : {}),
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(screen.queryByText("Channel provider mounted")).toBeNull();
  },
);
it("does no additional Markdown parsing on ordinary typing", () => {
  const scan = vi.spyOn(markdown, "scanMarkdown");
  mount("An ordinary message without a channel trigger");
  expect(scan).not.toHaveBeenCalled();
});
it("accepts a published choice that React has not rendered yet", () => {
  let publish: ComposerCompletionProps["publish"] | undefined;
  const mentions: Contribution<ComposerCompletion> = {
    id: "mention-typeahead",
    key: "buzz.mentions/mention-typeahead",
    pluginId: "buzz.mentions",
    revision: "1",
    title: "Mention",
    match: ({ start }) => ({ start: 0, end: start, query: "Quill" }),
    component: (props) => {
      publish = props.publish;
      return null;
    },
  };
  const registered = [mentions];
  const editor = {
    observation: { revision: 1, text: "@Quill", start: 6, end: 6 },
    valid: () => true,
    observe: () => {},
    settle: () => {},
    invalidate: vi.fn(),
    keys: { current: undefined },
    composing: { current: false },
  } as unknown as CompletionEditor;
  const replace = vi.fn(() => true);
  render(
    <ComposerCompletions
      registry={{ snapshot: () => registered, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: document.createElement("div") as never }}
      replace={replace}
      resolved={{ text: "@Quill", recipients: [] }}
      session={{} as RelaySession}
      scope="test"
      channelId="c"
    />,
  );
  const edit = { text: "@QuillUnique" };
  const preventDefault = vi.fn();
  let handled: boolean | undefined;
  // A busy page can deliver Enter after publication and before its render.
  act(() => {
    publish?.({ items: [{ id: "quill", label: "QuillUnique", edit }] });
    handled = editor.keys.current?.({
      key: "Enter",
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault,
      stopPropagation: () => {},
    } as unknown as KeyboardEvent<ComposerInputElement>);
  });
  expect(handled).toBe(true);
  expect(preventDefault).toHaveBeenCalled();
  expect(replace).toHaveBeenCalledWith(
    edit,
    { start: 0, end: 6, query: "Quill" },
    editor.observation,
    "Enter",
  );
});
