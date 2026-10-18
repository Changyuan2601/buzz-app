// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
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
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";
import { writeView } from "../../shared/view-state";
import { ChannelsPage, type ArchiveShortcut } from "./ChannelsPage";

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
      snapshot: () => ({
        status: "ready" as const,
        data: {
          sections: [{ id: "work", name: "Work", order: 0 }],
          assignments: {},
          starred: [],
          muted: [],
        },
      }),
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
      attempt: {},
    }),
  } as unknown as Navigation;
  const archive: ArchiveShortcut = {};
  const page = () => (
    <ChannelNavigationProvider relay={relay}>
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
    name: "Archive channel: Planning",
  });
  expect(f.run).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(
    within(dialog).getByRole("button", { name: "Archive channel" }),
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
    screen.getByRole("dialog", { name: "Archive channel: Roadmap" }),
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
      within(region).getByRole("button", { name: "Project: Work" }),
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
    within(region).getByRole("button", { name: "Add project" }),
  ).toBeVisible();
});

it("gives the owner's Solo chat its tag requirement and project", async () => {
  const f = fixture();
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Untagged{Enter}");
  expect(
    await screen.findByText("Tag an agent to send", {
      selector: "[role=alert]",
    }),
  ).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
});

it("uses the ordinary composer for a guest in a shared Solo chat", async () => {
  const f = fixture({ placed: false });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  expect(screen.queryByRole("button", { name: "Add project" })).toBeNull();
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  // Untagged, it reaches the chat's agents like any Solo conversation.
  await waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  expect(f.send.mock.calls[0]?.slice(0, 3)).toEqual([
    id,
    "Hello team",
    [agent],
  ]);
});

it.each([
  ["archive", "Archive channel", "Archive channel: Planning"],
  ["delete", "Delete channel", "Delete Planning?"],
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

it("returns focus to Chat actions when its confirmation is cancelled", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Archive channel" }),
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
