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
import { keypair, profile, signed } from "../../features/relay/testing";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
type KitSnapshot = ReturnType<
  ReturnType<typeof createRelaySession>["session"]["mePlacement"]["snapshot"]
>;
import type { RelayData } from "../../features/relay/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { writeView } from "../../shared/view-state";
import { meTarget } from "../me/routes";
import { SessionsPage, type ArchiveShortcut } from "./SessionsPage";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.unstubAllGlobals();
});
const id = "11111111-1111-4111-8111-111111111111";
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contribution, inline: contribution };
function fixture(
  status: KitSnapshot["status"] = "ready",
  retained = true,
  otherMembers: readonly string[] = [],
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const relayAuthor = keypair();
  const query = vi.fn(
    async (_filters: readonly ReadFilter[]): Promise<RelayEvent[]> => [],
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayAuthor.pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query,
      memberAdministration: {
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
      writer: {
        kinds: [9],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const scope = `https://test.example:${viewer.pubkey}`;
  let state: KitSnapshot = {
    ...owner.session.mePlacement.snapshot(),
    status,
    entries: [],
  };
  const listeners = new Set<() => void>();
  const channel: ChannelSummary = {
    id,
    name: "Planning",
    channelType: "session",
    members: [viewer.pubkey, ...otherMembers],
  };
  let list = {
    status: retained ? ("ready" as const) : ("loading" as const),
    channels: retained ? [channel] : [],
  };
  const listListeners = new Set<() => void>();
  const window = {
    ...owner.session.channels.window(id),
    status: "ready" as const,
    rows: [],
  };
  const set = vi.fn(async () => {});
  // Like the relay, settle the roster before the confirmed action resolves.
  const run = vi.fn(async (action: string) => {
    list = {
      ...list,
      channels: action === "archive" ? [{ ...channel, archived: true }] : [],
    };
    for (const listener of listListeners) listener();
  });
  const refresh = vi.fn(async () => {});
  const session = {
    ...owner.session,
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
      window: () => window,
      ensure() {},
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
    mePlacement: {
      ...owner.session.mePlacement,
      available: true,
      snapshot: () => state,
      ensure() {},
      refresh,
      set,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const snapshot = { status: "ready" as const, generation: 1, scope, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const abort = new AbortController();
  const navigation: PageNavigation = {
    entryId: "visit",
    target: meTarget(scope, id),
    signal: abort.signal,
    forSession: () => navigation,
    complete: () => true,
    resolve: () => true,
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const archive: ArchiveShortcut = {};
  const page = () => (
    <SessionsPage
      relay={relay}
      panels={{ ...contribution, register() {}, resolve: () => undefined }}
      extensions={extensions}
      navigation={navigation}
      navigator={{ open } as unknown as Navigation}
      archive={archive}
    />
  );
  const mount = () => render(page());
  return {
    mount,
    page,
    viewer,
    relayAuthor,
    query,
    abort,
    archive,
    set,
    run,
    refresh,
    open,
    scope,
    session,
    update(next: KitSnapshot) {
      state = next;
      for (const listener of listeners) listener();
    },
    state,
  };
}
it("keeps the current audience and removal controls available after Share fails to move a chat", async () => {
  const person = keypair();
  // Start with an existing member; grant confirmation is covered by SessionShare tests.
  const f = fixture("ready", true, [person.pubkey]);
  f.query.mockImplementation(async (filters) =>
    [
      signed(f.relayAuthor, {
        kind: 39002,
        content: "",
        tags: [
          ["d", id],
          ["p", f.viewer.pubkey, "", "owner"],
          ["p", person.pubkey, "", "member"],
        ],
      }),
      signed(f.relayAuthor, {
        kind: 39000,
        content: "",
        tags: [["d", id], ["t", "stream"], ["private"], ["name", "Planning"]],
      }),
      signed(f.relayAuthor, {
        kind: 39001,
        content: "",
        tags: [
          ["d", id],
          ["p", f.viewer.pubkey, "owner"],
        ],
      }),
      profile(f.viewer, { name: "Viewer" }),
      profile(person, { name: "Aria" }),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter))),
  );
  f.update({
    ...f.state,
    entries: [
      {
        eventId: "placement",
        createdAt: 1,
        record: {
          version: 2,
          community: "https://test.example",
          deleted: false,
          value: {
            type: "groups",
            id: "me",
            groups: [],
            assignments: {},
            channels: [id],
          },
        },
      },
    ],
  });
  // Populate the real session's access evidence, not only the page's retained list.
  await f.session.read([{ kinds: [39000, 39002], "#d": [id], limit: 2 }]);
  f.set.mockRejectedValue(new Error("Placement refused"));
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const share = screen.getByRole("dialog", { name: "Share conversation" });
  const submit = within(share).getByRole("button", { name: "Share" });
  await waitFor(() => expect(submit).toBeEnabled());
  await user.click(submit);
  expect(await within(share).findByRole("alert")).toHaveTextContent(
    "Placement refused",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Channel members" }));
  const members = screen.getByRole("dialog", { name: "Channel members" });
  await user.click(
    await within(members).findByRole("button", { name: "Actions for Aria" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove from channel" }),
  );
  const confirmation = screen.getByRole("dialog", {
    name: "Remove member from channel",
  });
  expect(
    within(confirmation).getByRole("button", { name: "Remove member" }),
  ).toBeEnabled();
});

it.each([false, true])(
  "keeps retained transcript available while Me placement loads (retained=%s)",
  (retained) => {
    const f = fixture("loading", retained);
    f.mount();
    expect(screen.getByText("Loading Solo chats…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry Solo" })).toBeNull();
    if (retained) {
      expect(screen.getByLabelText("Channel message history")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
    } else
      expect(screen.queryByLabelText("Channel message history")).toBeNull();
  },
);
it("keeps failed placement read-only and restores sending after confirmed preferences", async () => {
  const f = fixture("loading");
  writeView(f.scope, `draft:${id}`, "Saved thought");
  f.mount();
  act(() =>
    f.update({
      ...f.state,
      status: "error",
      error: "Network unavailable",
      transient: true,
    }),
  );
  expect(screen.queryByRole("button", { name: "Retry Solo" })).toBeNull();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(f.refresh).not.toHaveBeenCalled();
  act(() =>
    f.update({ ...f.state, status: "error", error: "Preferences offline" }),
  );
  expect(screen.getByText("Preferences offline")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Retry Solo" }));
  expect(f.refresh).toHaveBeenCalledOnce();
  act(() => f.update({ ...f.state, status: "ready" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Saved thought");
});
it.each([false, true])(
  "does not reopen a stale visit after unified Share settles (failure=%s)",
  async (failure) => {
    const f = fixture();
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const held = { promise, resolve, reject };
    f.set.mockImplementation(() => held.promise);
    f.mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Share" }));
    const dialog = screen.getByRole("dialog", { name: "Share conversation" });
    const share = within(dialog).getByRole("button", {
      name: "Share",
    });
    await waitFor(() => expect(share).toBeEnabled());
    await user.click(share);
    await waitFor(() => expect(f.set).toHaveBeenCalledOnce());
    f.abort.abort();
    await act(async () => {
      if (failure) held.reject(new Error("Late failure"));
      else held.resolve();
      await held.promise.catch(() => {});
    });
    expect(f.open).not.toHaveBeenCalled();
    expect(screen.queryByText("Late failure")).toBeNull();
  },
);
it("opens a pending Me start through its original receipt after its section was deleted", () => {
  const f = fixture();
  writeView(f.scope, "me:section:deleted:pending", {
    id,
    text: "Recover",
    creationId: "c".repeat(64),
    setup: { sectionId: "deleted", canvas: "Frozen instructions", agents: [] },
  });
  f.mount();
  expect(screen.getByRole("region", { name: "New chat" })).toBeVisible();
  expect(screen.queryByLabelText("Channel message history")).toBeNull();
});

it("opens an already-moved Me route in Messages without a placement or settings write", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open in Multiplayer" }));
  expect(f.open).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: "conversation", channelId: id }),
  );
  expect(f.set).not.toHaveBeenCalled();
  expect(f.session.channelDetails.load).not.toHaveBeenCalled();
});

it.each([
  ["archive", "Archive channel"],
  ["delete", "Delete channel"],
] as const)(
  "runs %s from Session actions and leaves the conversation",
  async (action, label) => {
    const f = fixture();
    f.mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(await screen.findByRole("menuitem", { name: label }));
    const dialog = screen.getByRole("dialog", {
      name: `${label}: Planning`,
    });
    await user.click(within(dialog).getByRole("button", { name: label }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      action,
      id,
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledExactlyOnceWith(meTarget(f.scope));
  },
);

it("confirms Archive from the shortcut, then leaves the archived chat", async () => {
  const f = fixture();
  f.mount();
  expect(f.archive.current?.available()).toBe(true);
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
  expect(f.open).toHaveBeenCalledExactlyOnceWith(meTarget(f.scope));
  expect(f.archive.current).toBeUndefined();
});

it("opens no Archive from the shortcut where the menu offers none", async () => {
  const f = fixture();
  f.mount();
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
  expect(f.session.channelLifecycle.load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.run).not.toHaveBeenCalled();
});

it("stops offering the Archive shortcut when its visit ends", () => {
  const f = fixture();
  f.mount();
  f.abort.abort();
  expect(f.archive.current?.available()).toBe(false);
});

it("drops a pending Delete confirmation when its visit ends", async () => {
  const f = fixture();
  let finish!: () => void;
  const settled = f.run.getMockImplementation();
  f.run.mockImplementation(async (action) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await settled?.(action);
  });
  const view = f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Session actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete channel" }),
  );
  const dialog = screen.getByRole("dialog", {
    name: "Delete channel: Planning",
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Delete channel" }),
  );
  await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  f.abort.abort();
  view.rerender(f.page());
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => finish());
  expect(f.open).not.toHaveBeenCalled();
});

it("stays put when a confirmation lands after its visit ends but before rerender", async () => {
  const f = fixture();
  let finish!: () => void;
  const settled = f.run.getMockImplementation();
  f.run.mockImplementation(async (action) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await settled?.(action);
  });
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Session actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Archive channel" }),
  );
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Archive channel",
    }),
  );
  await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  f.abort.abort();
  await act(async () => finish());
  expect(f.open).not.toHaveBeenCalled();
});

it("returns focus to Session actions when the confirmation is cancelled", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Session actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Archive channel" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(f.run).not.toHaveBeenCalled();
});
