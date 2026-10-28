// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RegisteredPanel } from "../../features/panels/service";
import { panelTabId, useChannelTabState } from "./useChannelTabState";
import {
  readTabWorkspaces,
  tabWorkspaceStorageKey,
} from "./tab-workspace-storage";

const session = (origin = "https://community.example", viewer = "viewer") =>
  ({ scope: `${origin}:${viewer}`, viewer }) as RelaySession;
const mount = (queries = session(), channel = "alpha", page = "messages") =>
  renderHook(() => useChannelTabState(queries, channel, page));
const profile = { key: "buzz.profiles/profile" } as RegisteredPanel;
const github = { key: "buzz.github/object" } as RegisteredPanel;
const opening = (panel = profile) => ({
  panel,
  target: `${panel.key}:target`,
  channelId: "alpha",
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

test("reload restores tabs, pane order, names, selection and visit associations without replaying requests", () => {
  const first = mount();
  act(() => {
    first.result.current.enterVisit("one:channel");
    first.result.current.setEntries([opening()]);
    first.result.current.openThreadTab(
      "alpha",
      "reply",
      "root",
      "reply",
      "main",
    );
    first.result.current.renameTab("thread:alpha:root", "Named thread");
    first.result.current.leaveVisit();
    first.result.current.enterVisit("two:thread", {
      channelId: "alpha",
      messageId: "reply",
      rootId: "root",
    });
    first.result.current.openThreadTab(
      "alpha",
      "other",
      "other",
      "focus",
      "side",
    );
    first.result.current.setPaneOpen(false);
  });
  const prior = first.result.current;
  first.unmount();
  const restored = mount();
  act(() => restored.result.current.restoreEntries(() => profile));
  expect(restored.result.current).toMatchObject({
    selected: prior.selected,
    mainSelected: prior.mainSelected,
    paneOpen: false,
    visit: "two:thread",
    visits: prior.visits,
    entries: [opening()],
    tabs: [
      {
        id: "thread:alpha:root",
        kind: "thread",
        pane: "main",
        name: "Named thread",
      },
      { id: "thread:alpha:other", kind: "thread", pane: "side" },
    ],
  });
  for (const tab of restored.result.current.tabs) {
    expect(tab.focusRequest).toBeUndefined();
    if (tab.kind === "thread") expect(tab.replyRequest).toBeUndefined();
  }
  act(() => restored.result.current.enterVisit("one:channel"));
  expect(restored.result.current.mainSelected).toBe("thread:alpha:root");
});

test("reload isolates community, viewer, page and channel workspaces", () => {
  const firstSession = session();
  const first = renderHook(() => useChannelTabState(firstSession, "alpha"));
  act(() => first.result.current.openThreadTab("alpha", "root", "root"));
  first.unmount();
  for (const [queries, channel, page] of [
    [session("https://other.example"), "alpha", "messages"],
    [session(undefined, "other-viewer"), "alpha", "messages"],
    [session(), "beta", "messages"],
    [session(), "alpha", "page:inbox"],
  ] as const) {
    const next = renderHook(() => useChannelTabState(queries, channel, page));
    expect(next.result.current.tabs).toEqual([]);
    next.unmount();
  }
  expect(mount().result.current.tabs).toHaveLength(1);
});

test("delayed panel registrations keep their order, placement and selection across another reload", () => {
  const first = mount();
  act(() => {
    first.result.current.setEntries([
      opening({ key: "buzz.terminal/terminal" } as RegisteredPanel),
      opening(),
      opening(github),
    ]);
    first.result.current.moveEntry(panelTabId(opening()), "main");
    first.result.current.select(panelTabId(opening(github)));
  });
  first.unmount();
  const pending = mount();
  act(() => {
    pending.result.current.restoreEntries(() => undefined);
    pending.result.current.setEntries([]);
    pending.result.current.setPaneOpen(false);
  });
  expect(pending.result.current.entries).toEqual([]);
  pending.unmount();
  const restored = mount();
  act(() =>
    restored.result.current.restoreEntries((key) =>
      key === github.key ? github : undefined,
    ),
  );
  act(() =>
    restored.result.current.restoreEntries((key) =>
      key === profile.key ? profile : undefined,
    ),
  );
  expect(restored.result.current.entries).toEqual([opening(), opening(github)]);
  expect(restored.result.current.mainEntries).toEqual([panelTabId(opening())]);
  expect(restored.result.current.selected).toBe(panelTabId(opening(github)));
  expect(restored.result.current.paneOpen).toBe(false);
});

test("close all retires pending panel targets and never restores channel tools", () => {
  const first = mount();
  act(() =>
    first.result.current.setEntries([
      opening(),
      opening({ key: "buzz.terminal/terminal" } as RegisteredPanel),
      {
        ...opening(github),
        channelContext: {
          scope: "scope",
          viewer: "viewer",
          channelId: "alpha",
          channelName: "Alpha",
          relayUrl: "wss://community.example",
        },
      },
    ]),
  );
  first.unmount();
  const restored = mount();
  expect(restored.result.current.pendingEntries).toHaveLength(1);
  act(() => restored.result.current.closeTabs());
  act(() => restored.result.current.restoreEntries(() => profile));
  expect(restored.result.current.entries).toEqual([]);
  restored.unmount();
  expect(mount().result.current.pendingEntries).toEqual([]);
});

test("unavailable storage leaves live workspace actions usable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const live = mount();
  act(() => live.result.current.openThreadTab("alpha", "root", "root"));
  expect(live.result.current.tabs).toHaveLength(1);
});

test("corrupt and unsupported snapshots are ignored", () => {
  const queries = session();
  for (const raw of [
    "{",
    "null",
    '{"version":2,"workspaces":{}}',
    '{"version":1,"workspaces":{"invalid":{"tabs":[],"entries":[],"selected":12,"paneOpen":true}}}',
  ]) {
    sessionStorage.setItem(tabWorkspaceStorageKey(queries.scope), raw);
    expect(readTabWorkspaces(queries)).toEqual({});
  }
});

test("domain-owned dismissal associations survive without hydrating runtime state", () => {
  const queries = session();
  const metadata = {
    routedVisits: {
      old: { channelId: "alpha", messageId: "reply", rootId: "root" },
    },
    detailVisits: { profile: { channelId: "alpha", target: "profile" } },
  };
  sessionStorage.setItem(
    tabWorkspaceStorageKey(queries.scope),
    JSON.stringify({
      version: 1,
      workspaces: {
        '["messages","alpha"]': {
          tabs: [],
          entries: [],
          selected: "thread",
          paneOpen: true,
          ...metadata,
        },
      },
    }),
  );
  const restored = mount(queries);
  expect(readTabWorkspaces(queries)['["messages","alpha"]']).toMatchObject(
    metadata,
  );
  act(() => restored.result.current.setPaneOpen(false));
  expect(readTabWorkspaces(session())['["messages","alpha"]']).toMatchObject(
    metadata,
  );
});

test("a replaced session's late callbacks cannot overwrite the current saved workspace", () => {
  const first = mount();
  act(() => first.result.current.openThreadTab("alpha", "first", "first"));
  const lateSelect = first.result.current.select;
  first.unmount();
  const current = mount();
  act(() => current.result.current.openThreadTab("alpha", "second", "second"));
  act(() => lateSelect("thread:alpha:first"));
  current.unmount();
  expect(mount().result.current.tabs.map((tab) => tab.id)).toEqual([
    "thread:alpha:first",
    "thread:alpha:second",
  ]);
});

test("reload restores channel settings with a fresh opening identity and its pane selection", () => {
  const first = mount();
  act(() => first.result.current.setSettings({ channelId: "alpha" }));
  const previousId = first.result.current.settings?.id;
  act(() => first.result.current.setPaneOpen(false));
  first.unmount();
  const restored = mount();
  expect(restored.result.current).toMatchObject({
    settings: { channelId: "alpha" },
    selected: "settings",
    paneOpen: false,
  });
  expect(restored.result.current.settings?.id).not.toBe(previousId);
  const saved = JSON.parse(
    sessionStorage.getItem(tabWorkspaceStorageKey(session().scope)) ?? "null",
  );
  expect(saved.workspaces['["messages","alpha"]'].settings).toEqual({
    channelId: "alpha",
  });
  act(() => restored.result.current.setSettings(undefined));
  restored.unmount();
  expect(mount().result.current.settings).toBeUndefined();
});

test("restored channel settings cannot belong to a different channel", () => {
  const first = mount();
  act(() => first.result.current.setSettings({ channelId: "beta" }));
  first.unmount();
  expect(mount().result.current.settings).toBeUndefined();
});
