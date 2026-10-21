import { stubAvatarBrowserApis } from "../agents/avatar-testing";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  fixture,
  owners,
  scope,
  agent,
  viewer,
} from "../../app/shell/sidebar-testing";
import { composerDOMFixture } from "../messages/composer-testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { writeView } from "../../shared/view-state";
import type { ChannelSummary, ChannelWindow } from "../relay/contracts";
import type { ChannelTimelineProps } from "../messages/ChannelTimeline";
import { NewChatDraft } from "./NewChatDraft";
// Keep recipient selection, matching, window subscription and sending real;
// timeline geometry has its own renderer coverage.
vi.mock("../messages/ChannelTimeline", () => ({
  ChannelTimeline: ({ window }: ChannelTimelineProps) => (
    <section aria-label="Conversation history">
      {window.rows.map((row) => (
        <p key={row.id}>{row.content}</p>
      ))}
    </section>
  ),
}));
composerDOMFixture();
stubAvatarBrowserApis();
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
it.each(["private", "open"] as const)(
  "creates a %s chat only on first send and reuses it after a failed send",
  async (visibility) => {
    const f = fixture(true, true);
    const operations: readonly never[] = [];
    const create = vi
      .spyOn(f.session.channelCreation, "create")
      .mockResolvedValue("created-chat");
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Send unavailable");
      })
      .mockReturnValue("message-id");
    Object.assign(f.session, {
      outbox: {
        ...f.session.outbox,
        supports: () => true,
        subscribe: () => () => {},
        snapshot: () => operations,
      },
      messages: { ...f.session.messages, send },
    });
    writeView(scope, "chat-creation:inline-draft", {
      text: "Hello there",
      recipients: [],
    });
    const opened = vi.fn();
    render(
      <ToastProvider>
        <NewChatDraft session={f.session} scope={scope} onStarted={opened} />
      </ToastProvider>,
    );
    const user = userEvent.setup();
    expect(
      screen.getByRole("combobox", { name: "Message recipients" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Chat visibility: Private" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("textbox", { name: "Message your new chat" }),
    ).toHaveAttribute("contenteditable", "true");
    if (visibility === "open") {
      screen.getByRole("button", { name: "Chat visibility: Private" }).focus();
      await user.keyboard("{Enter}");
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Public" }),
      );
    }
    expect(create).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole("button", { name: "Send message" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Send unavailable",
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ visibility }),
    );
    expect(opened).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith("created-chat"));
    expect(create).toHaveBeenCalledOnce();
    expect(send).toHaveBeenLastCalledWith(
      "created-chat",
      "Hello there",
      [],
      [],
    );
  },
);

it("does not send or navigate when creation finishes after leaving the draft", async () => {
  const f = fixture(true, true);
  const operations: readonly never[] = [];
  const send = vi.fn();
  Object.assign(f.session, {
    outbox: {
      ...f.session.outbox,
      supports: () => true,
      subscribe: () => () => {},
      snapshot: () => operations,
    },
    messages: { ...f.session.messages, send },
  });
  let finish!: (id: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const create = vi
    .spyOn(f.session.channelCreation, "create")
    .mockReturnValue(pending);
  writeView(scope, "chat-creation:inline-draft", {
    text: "Keep this draft",
    recipients: [],
  });
  const opened = vi.fn();
  const view = render(
    <ToastProvider>
      <NewChatDraft session={f.session} scope={scope} onStarted={opened} />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  try {
    await user.click(
      await screen.findByRole("button", { name: "Send message" }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    view.unmount();
  } finally {
    await act(async () => {
      finish("created-chat");
      await pending;
    });
  }
  expect(send).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
});

it("loads exact recipient history as selections change and sends into the matched chat", async () => {
  const f = fixture(true, true);
  const person = "e".repeat(64);
  const channels: ChannelSummary[] = [
    {
      id: "solo-agent",
      name: "Agent conversation",
      visibility: "private",
      members: [viewer, agent],
      lastActivityAt: 1,
    },
    {
      id: "group",
      name: "Group conversation",
      visibility: "private",
      members: [person, agent, viewer],
      lastActivityAt: 2,
    },
    {
      id: "older-group",
      name: "Older group",
      visibility: "private",
      members: [viewer, agent, person],
      lastActivityAt: 1,
    },
    {
      id: "public",
      name: "Public",
      visibility: "public",
      members: [viewer, agent, person],
      lastActivityAt: 9,
    },
    {
      id: "archived",
      name: "Archived",
      visibility: "private",
      archived: true,
      members: [viewer, agent, person],
      lastActivityAt: 10,
    },
  ];
  const list = { status: "ready" as const, channels };
  const windows = new Map(
    channels.map((channel) => [
      channel.id,
      {
        channelId: channel.id,
        status: "ready",
        hasMore: false,
        loadingOlder: false,
        error: undefined,
        rows: [
          {
            id: channel.id,
            channelId: channel.id,
            authorId: viewer,
            createdAt: 1,
            content: `History for ${channel.id}`,
            mentions: [],
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          },
        ],
      } satisfies ChannelWindow,
    ]),
  );
  const send = vi.fn().mockReturnValue("sent");
  const create = vi.spyOn(f.session.channelCreation, "create");
  const operations: readonly never[] = [];
  Object.assign(f.session, {
    outbox: {
      ...f.session.outbox,
      supports: () => true,
      subscribe: () => () => {},
      snapshot: () => operations,
      observeSend: () => () => {},
    },
    channels: {
      ...f.session.channels,
      list: () => list,
      ensure: () => {},
      window: (id: string) => {
        const window = windows.get(id);
        if (!window) throw new Error(`Unexpected history request: ${id}`);
        return window;
      },
      subscribeWindow: () => () => {},
    },
    directMessages: {
      ...f.session.directMessages,
      people: async () => ({
        people: [{ pubkey: person, name: "Alex" }],
        hasMore: false,
      }),
    },
    messages: { ...f.session.messages, send },
  });
  writeView(scope, "chat-creation:inline-draft", {
    text: "Keep my draft",
    recipients: [],
  });
  const opened = vi.fn();
  render(
    <ToastProvider>
      <NewChatDraft session={f.session} scope={scope} onStarted={opened} />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("combobox", { name: "Message recipients" }),
    "Owned",
  );
  await user.click(await screen.findByRole("option", { name: /Owned Agent/ }));
  expect(await screen.findByText("History for solo-agent")).toBeInTheDocument();
  const recipients = screen.getByRole("combobox", {
    name: "Message recipients",
  });
  await user.click(recipients);
  await user.type(recipients, "Alex");
  await user.click(await screen.findByRole("option", { name: "Alex" }));
  expect(await screen.findByText("History for group")).toBeInTheDocument();
  expect(screen.queryByText("History for solo-agent")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Chat visibility: Private" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Public" }),
  );
  expect(
    screen.queryByRole("region", { name: "Conversation history" }),
  ).not.toBeInTheDocument();
  expect(screen.getByTitle("Owned Agent")).toBeInTheDocument();
  expect(screen.getByTitle("Alex")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Chat visibility: Public" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Private" }),
  );
  expect(await screen.findByText("History for group")).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Start a conversation" }),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole("textbox", { name: "Message your new chat" }),
  ).toHaveTextContent("Keep my draft");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith("group"));
  expect(create).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith("group", "Keep my draft", [], []);
});
