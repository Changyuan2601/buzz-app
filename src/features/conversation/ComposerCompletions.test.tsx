// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCompletions } from "./ComposerCompletions";
import type { CompletionEditor } from "./useCompletionEditor";
import type { ComposerCompletion } from "./contracts";
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
it("shows a choice published in the provider's first commit", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input as unknown as Node);
  const [channel] = providers;
  if (!channel) throw new Error("Missing channel provider");
  const provider: Contribution<ComposerCompletion> = {
    ...channel,
    component: ({ publish }) => {
      useLayoutEffect(() => {
        const withdraw = publish({
          items: [
            { id: "general", label: "general", edit: { text: "#general" } },
          ],
        });
        return () => {
          if (withdraw) withdraw();
        };
      }, [publish]);
      return null;
    },
  };
  const editor = {
    observation: { revision: 1, text: "#ge", start: 3, end: 3 },
    valid: () => true,
    observe: () => {},
    invalidate: () => {},
    keys: { current: undefined },
    composing: { current: false },
  } as CompletionEditor;
  const registered = [provider];
  const replace = vi.fn(() => true);
  render(
    <ComposerCompletions
      registry={{ snapshot: () => registered, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: input }}
      replace={replace}
      resolved={{ text: "#ge", recipients: [] }}
      session={{} as RelaySession}
      scope="test"
      channelId="c"
    />,
  );
  // One synchronous render owns the choice: a queued Enter accepts it.
  expect(screen.queryByRole("option", { name: "general" })).not.toBeNull();
  const enter = {
    key: "Enter",
    nativeEvent: { isComposing: false, keyCode: 13 },
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as Parameters<
    NonNullable<CompletionEditor["keys"]["current"]>
  >[0];
  expect(editor.keys.current?.(enter)).toBe(true);
  expect(replace).toHaveBeenCalledOnce();
  input.remove();
  vi.unstubAllGlobals();
});
it("keeps the menu across filter keystrokes and hides it without a fresh result", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = () => {};
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input as unknown as Node);
  const [channel] = providers;
  if (!channel) throw new Error("Missing channel provider");
  const provider: Contribution<ComposerCompletion> = {
    ...channel,
    component: ({ publish, query }) => {
      useLayoutEffect(() => {
        if (query.query === "gx") return;
        const withdraw = publish({
          items: [
            { id: "general", label: "general", edit: { text: "#general" } },
          ],
        });
        return () => {
          if (withdraw) withdraw();
        };
      }, [publish, query.query]);
      return null;
    },
  };
  const registered = [provider];
  const view = (revision: number, text: string) => (
    <ComposerCompletions
      registry={{ snapshot: () => registered, subscribe: () => () => {} }}
      editor={
        {
          observation: {
            revision,
            text,
            start: text.length,
            end: text.length,
          },
          valid: () => true,
          observe: () => {},
          invalidate: () => {},
          keys: { current: undefined },
          composing: { current: false },
        } as CompletionEditor
      }
      input={{ current: input }}
      replace={() => true}
      resolved={{ text, recipients: [] }}
      session={{} as RelaySession}
      scope="test"
      channelId="c"
    />
  );
  const { rerender } = render(view(1, "#g"));
  const listbox = screen.getByRole("listbox");
  rerender(view(2, "#ge"));
  expect(screen.getByRole("listbox")).toBe(listbox);
  expect(screen.queryByRole("option", { name: "general" })).not.toBeNull();
  rerender(view(3, "#gx"));
  expect(screen.queryByRole("listbox")).toBeNull();
  input.remove();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.unstubAllGlobals();
});
