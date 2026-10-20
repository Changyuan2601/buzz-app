// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayData } from "../../features/relay/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";
import {
  readShareBack,
  shareBackKey,
  linkedDraftKey,
} from "../../features/solo/linked-chat";
import { readView, writeView } from "../../shared/view-state";
import { ChannelsPage, type ArchiveShortcut } from "./ChannelsPage";
import { SoloWorkspaces } from "./SoloWorkspaces";
import type { RelaySession } from "../../features/relay/session";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.unstubAllGlobals();
});
const id = "11111111-1111-4111-8111-111111111111";
const agent = "a".repeat(64);
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contribution, inline: contribution };
function fixture({
  placed = true,
  type = "solo",
  target,
}: {
  /** Whether the viewer created the chat, rather than joining it as a guest. */
  placed?: boolean;
  type?: "solo" | "stream";
  target?: (scope: string) => OpenTarget;
} = {}) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: keypair().pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query: async () => [],
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const scope = `https://test.example:${viewer.pubkey}`;
  const listeners = new Set<() => void>();
  const channel: ChannelSummary = {
    id,
    name: "Planning",
    channelType: type,
    private: true as const,
    creator: placed ? viewer.pubkey : agent,
    members: [viewer.pubkey, agent],
  };
  let list = { status: "ready" as const, channels: [channel] };
  const listListeners = new Set<() => void>();
  const emitList = () => {
    for (const listener of listListeners) listener();
  };
  const window = {
    ...owner.session.channels.window(id),
    status: "ready" as const,
    rows: [],
  };
  const send = vi.fn<typeof owner.session.messages.send>(() => "d".repeat(64));
  // Like the relay, settle the roster before the confirmed action resolves.
  const run = vi.fn(
    async (action: string, _id?: string, _signal?: AbortSignal) => {
      list = {
        ...list,
        channels: action === "archive" ? [{ ...channel, archived: true }] : [],
      };
      emitList();
    },
  );
  // The default agent comes first, so a named agent is distinguishable from it.
  const agents = [
    { pubkey: "b".repeat(64), name: "Helper", managed: false },
    { pubkey: agent, name: "Scout", managed: false },
  ];
  const choices = {
    ...owner.session.agentChoices.snapshot(),
    status: "ready" as const,
    complete: true,
    identities: agents,
    selectable: agents,
    archives: { status: "unavailable" as const, archived: [] },
  };
  // A stable snapshot, as useSyncExternalStore requires.
  const projects = {
    status: "ready" as const,
    data: {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: {},
      starred: [],
      muted: [],
    },
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...owner.session.agentChoices,
      retain: () => () => {},
      snapshot: () => choices,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    channelLifecycle: {
      ...owner.session.channelLifecycle,
      available: true,
      load: vi.fn(async () => ({
        channelId: id,
        channelType: "stream" as const,
        canArchive: true,
        canUnarchive: false,
        canDelete: true,
        canLeave: false,
        canHide: false,
      })),
      run,
    },
    channelDetails: {
      ...owner.session.channelDetails,
      available: true,
      load: vi.fn(async () => ({
        channelId: id,
        version: "test",
        name: "Planning",
        description: "",
        visibility: "private" as const,
        canEdit: true,
      })),
    },
    channels: {
      ...owner.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listListeners.add(listener);
        return () => {
          listListeners.delete(listener);
        };
      },
      ensureList() {},
      refreshRoster: vi.fn(async () => true),
      window: () => window,
      ensure() {},
    },
    soloPreferences: {
      ...owner.session.soloPreferences,
      snapshot: () => projects,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    messages: { ...owner.session.messages, send },
    channelWrites: {
      ...owner.session.channelWrites,
      available: true,
      create: vi.fn<RelaySession["channelWrites"]["create"]>(() =>
        "c".repeat(64),
      ),
      delivered: vi.fn<RelaySession["channelWrites"]["delivered"]>(
        async () => {},
      ),
      refresh: vi.fn(async (channelId: string) => {
        list = {
          ...list,
          channels: [...list.channels, { ...channel, id: channelId }],
        };
        emitList();
      }),
      addAgents: vi.fn<RelaySession["channelWrites"]["addAgents"]>(async () => {
        list = { ...list, channels: [...list.channels] };
        emitList();
      }),
      refreshMembership: vi.fn(async () => channel),
    },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const abort = new AbortController();
  const complete = vi.fn(() => true);
  const navigation: PageNavigation = {
    entryId: "visit",
    target: target?.(scope) ?? conversationTarget(scope, id),
    signal: abort.signal,
    forSession: () => navigation,
    complete,
    resolve: () => true,
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = {
    open,
    retry() {},
    snapshot: () => ({
      entry: { id: navigation.entryId, target: navigation.target },
      attempt: { signal: abort.signal },
    }),
  } as unknown as Navigation;
  const archive: ArchiveShortcut = {};
  const page = (sidebar = false) => (
    <ChannelNavigationProvider relay={relay}>
      {sidebar && (
        <SoloWorkspaces
          session={session as unknown as RelaySession}
          navigator={navigator}
          scope={scope}
          chats={[{ id, title: "Planning" }]}
          renderChat={(item) => <button type="button">{item.title}</button>}
        />
      )}
      <ChannelsPage
        relay={relay}
        panels={{ ...contribution, register() {}, resolve: () => undefined }}
        extensions={extensions}
        navigation={navigation}
        navigator={navigator}
        archive={archive}
      />
    </ChannelNavigationProvider>
  );
  return {
    mount: () => render(page()),
    mountWithSidebar: () => render(page(true)),
    mountWithToasts: () => render(<ToastProvider>{page()}</ToastProvider>),
    abort,
    archive,
    open,
    run,
    send,
    scope,
    session,
    // Chat activity: a new summary object for the same chat.
    retitle(name: string) {
      list = { ...list, channels: [{ ...channel, name }] };
      emitList();
    },
  };
}
it("confirms Archive from the shortcut, then opens a new Solo draft", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current?.available()).toBe(true));
  await act(async () => f.archive.current?.run());
  expect(f.session.channelLifecycle.load).toHaveBeenCalledWith(
    id,
    expect.any(AbortSignal),
  );
  const dialog = screen.getByRole("dialog", {
    name: "Archive chat: Planning",
  });
  expect(f.run).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(
    within(dialog).getByRole("button", { name: "Archive chat" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.run).toHaveBeenCalledExactlyOnceWith(
    "archive",
    id,
    expect.any(AbortSignal),
  );
  expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
  expect(f.archive.current).toBeUndefined();
});

it("offers no Archive shortcut outside a Solo chat", async () => {
  const f = fixture({ type: "stream" });
  f.mount();
  await screen.findByRole("textbox", { name: "Message #Planning" });
  expect(f.archive.current).toBeUndefined();
});

it("retires the Archive shortcut once the chat is archived", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  await act(() => f.run("archive"));
  await waitFor(() => expect(f.archive.current).toBeUndefined());
});

it("opens no Archive from the shortcut where the menu offers none", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  f.session.channelLifecycle.load.mockResolvedValueOnce({
    channelId: id,
    channelType: "stream",
    canArchive: false,
    canUnarchive: false,
    canDelete: false,
    canLeave: true,
    canHide: false,
  });
  await act(async () => f.archive.current?.run());
  f.session.channelLifecycle.load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => f.archive.current?.run());
  // Each press reads permission afresh.
  expect(f.session.channelLifecycle.load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.run).not.toHaveBeenCalled();
});

it("keeps a shortcut Archive across chat activity during the permission read", async () => {
  const f = fixture();
  let release = () => {};
  f.session.channelLifecycle.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            channelId: id,
            channelType: "stream",
            canArchive: true,
            canUnarchive: false,
            canDelete: true,
            canLeave: false,
            canHide: false,
          });
      }),
  );
  f.mount();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.archive.current?.run();
  });
  act(() => f.retitle("Roadmap"));
  await act(async () => {
    release();
    await pending;
  });
  // The confirmation names the latest summary, not the one at keypress.
  expect(
    screen.getByRole("dialog", { name: "Archive chat: Roadmap" }),
  ).toBeInTheDocument();
});

it("stops offering the Archive shortcut when its visit ends", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current?.available()).toBe(true));
  f.abort.abort();
  expect(f.archive.current?.available()).toBe(false);
});

it("renders a Solo draft route as the new chat composer", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope) });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  expect(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Channel message history")).toBeNull();
  expect(f.archive.current).toBeUndefined();
});

it("starts a Solo draft route in its project, with that project's saved draft", async () => {
  const f = fixture({
    target: (scope) => soloDraftTarget(scope, { project: "work" }),
  });
  writeView(f.scope, "solo:project:work:new-draft", {
    text: "Plan the week",
    recipients: [],
  });
  writeView(f.scope, "solo:new-draft", { text: "Unfiled", recipients: [] });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  expect(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  ).toHaveTextContent("Plan the week");
  await waitFor(() =>
    expect(
      within(region).getByRole("button", { name: "Workspace: Work" }),
    ).toBeEnabled(),
  );
});

it("tags a Solo draft route's agent in the new chat", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  await waitFor(() =>
    expect(
      within(region).getByRole("textbox", { name: "Message your agents" }),
    ).toHaveTextContent("@Scout"),
  );
  expect(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  ).not.toHaveTextContent("@Helper");
  expect(
    within(region).getByRole("button", { name: "Add workspace" }),
  ).toBeVisible();
});

it("gives the owner's Solo chat its tag requirement and project", async () => {
  const f = fixture();
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add workspace" })).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Untagged{Enter}");
  expect(
    await screen.findByText("Tag a person or agent to send", {
      selector: "[role=alert]",
    }),
  ).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
});

it("requires a guest to address someone explicitly in a shared Solo chat", async () => {
  const f = fixture({ placed: false });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  expect(screen.queryByRole("button", { name: "Add workspace" })).toBeNull();
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  expect(
    await screen.findByText("Tag a person or agent to send", {
      selector: "[role=alert]",
    }),
  ).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  ["archive", "Archive chat", "Archive chat: Planning"],
  ["delete", "Delete chat", "Delete Planning?"],
] as const)(
  "runs %s from Chat actions, then opens a new Solo draft",
  async (action, label, title) => {
    const f = fixture();
    f.mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Chat actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: label }));
    const dialog = screen.getByRole("dialog", { name: title });
    await user.click(within(dialog).getByRole("button", { name: label }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      action,
      id,
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
  },
);

it.each([
  ["open", true],
  ["another", false],
] as const)(
  "archives the %s chat from its sidebar row; only leaving the open chat opens a new Solo draft",
  async (_, open) => {
    const f = fixture(
      open ? {} : { target: (scope) => soloDraftTarget(scope) },
    );
    f.mountWithSidebar();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Actions for Planning" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Archive chat" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Archive chat: Planning",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Archive chat" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      "archive",
      id,
      expect.any(AbortSignal),
    );
    if (open)
      expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
    else expect(f.open).not.toHaveBeenCalled();
  },
);

it("offers the same chat actions from the header and the sidebar row", async () => {
  const f = fixture();
  f.mountWithSidebar();
  const user = userEvent.setup();
  const items = async (trigger: string) => {
    await user.click(await screen.findByRole("button", { name: trigger }));
    const menu = await screen.findByRole("menu", { name: trigger });
    await within(menu).findByRole("menuitem", { name: "Delete chat" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    return names;
  };
  const header = await items("Chat actions");
  expect(header).toEqual([
    "Share…",
    "Convert to channel",
    "Move to",
    "Copy",
    "Chat settings…",
    "Archive chat",
    "Delete chat",
  ]);
  expect(await items("Actions for Planning")).toEqual(header);
});

it("runs the header's own chat actions and returns focus to Chat actions", async () => {
  const f = fixture();
  const assign = vi.fn(async () => {});
  Object.assign(f.session.soloPreferences, { writable: true, assign });
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(assign).toHaveBeenCalledExactlyOnceWith(id, "work");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Chat settings…" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Chat settings" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("reports a failed header move beside the header and retries it", async () => {
  const f = fixture();
  const base = f.session.soloPreferences.snapshot();
  let current: ReturnType<typeof f.session.soloPreferences.snapshot> = base;
  const listeners = new Set<() => void>();
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const failed = {
    ...base,
    moves: [
      {
        id: 1,
        channelId: id,
        destination: { section: "work" },
        pending: false,
        error: "Relay unavailable",
      },
    ],
  } as unknown as typeof current;
  const retryMove = vi.fn(async () => {});
  Object.assign(f.session.soloPreferences, {
    writable: true,
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    assign: vi.fn(async () => {
      publish(failed);
      throw new Error("Relay unavailable");
    }),
    retryMove,
    dismissMoveError: () => publish(base),
  });
  f.mountWithToasts();
  const user = userEvent.setup();
  // No failure is shown for a move this header did not start.
  act(() => publish(failed));
  expect(screen.queryByText("Chat wasn’t moved")).toBeNull();
  act(() => publish(base));
  await user.click(await screen.findByRole("button", { name: "Chat actions" }));
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Chat wasn’t moved")).toBeVisible();
  // Toasts own swipe gestures, so press their buttons without a pointer.
  fireEvent.click(screen.getByRole("button", { name: "Retry move" }));
  expect(retryMove).toHaveBeenCalledExactlyOnceWith(id);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() =>
    expect(screen.queryByText("Chat wasn’t moved")).toBeNull(),
  );
});

it("returns focus to Chat actions when its confirmation is cancelled", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Archive chat" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("opens Chat settings from the heading and restores keyboard focus without navigating", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat settings" });
  expect(trigger).not.toHaveAttribute("aria-haspopup", "menu");
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Chat settings" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(f.open).not.toHaveBeenCalled();
});

it("does not recreate a consumed linked draft on history navigation", () => {
  const linked = "22222222-2222-4222-8222-222222222222";
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { linked }) });
  f.mount();
  expect(
    screen.getByText(
      "This linked chat draft is unavailable. Start again from its source.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(readView(f.scope, linkedDraftKey(linked), null)).toBeNull();
});

it("finishes a linked chat across roster updates without appending source prose", async () => {
  const linked = "22222222-2222-4222-8222-222222222222";
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { linked }) });
  const source = {
    channelId: "33333333-3333-4333-8333-333333333333",
    link: `buzz://message?channel=33333333-3333-4333-8333-333333333333&id=${"e".repeat(64)}`,
    threadRootId: "e".repeat(64),
    share: false,
  };
  writeView(f.scope, linkedDraftKey(linked), source);
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("Investigate this");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  expect(screen.queryByText("Draft unavailable")).toBeNull();
  expect(f.send.mock.calls[0]?.[1]).not.toContain("Source:");
  expect(f.session.channelWrites.create.mock.calls[0]).toHaveLength(4);
  expect(f.send.mock.calls[0]?.[1]).toContain(source.link);
});

it("keeps an interrupted first-send share for explicit retry without granting on reopen", async () => {
  const f = fixture();
  writeView(f.scope, shareBackKey(id), {
    channelId: "design",
    link: "buzz://channel/design",
    share: true,
    firstMessageId: "d".repeat(64),
    attempted: true,
  });
  f.mount();
  expect(
    await screen.findByRole("dialog", { name: "Share chat" }),
  ).toBeVisible();
  expect(f.session.channelWrites.delivered).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(readShareBack(f.scope, id)?.attempted).toBe(true);
});

it("a failed first message retires the automatic gate so later manual sharing is not trapped", async () => {
  const f = fixture();
  writeView(f.scope, shareBackKey(id), {
    channelId: "design",
    link: "buzz://channel/design",
    share: true,
    firstMessageId: "d".repeat(64),
  });
  f.session.channelWrites.delivered.mockRejectedValue(
    new Error("First send failed"),
  );
  f.mount();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "first message wasn’t confirmed",
  );
  expect(readShareBack(f.scope, id)).toBeUndefined();
  expect(f.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Start over" }));
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await userEvent.click(screen.getByRole("button", { name: /^Share$/ }));
  expect(
    await screen.findByRole("dialog", { name: "Share chat" }),
  ).toBeVisible();
  expect(f.session.channelWrites.delivered).toHaveBeenCalledOnce();
});
