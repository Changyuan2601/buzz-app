// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type {
  ChannelLauncherProps,
  PanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import { channelTabs, tabPane, useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

afterEach(cleanup);
it("background opening preserves the panel shown after moving a side thread to main", () => {
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const panel = { key: "info", title: "Info" } as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const h = renderHook(() => {
    const state = useChannelTabState(session, "alpha");
    const workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      mainPane: true,
      isLive: () => true,
      openLink: () => false,
    });
    return { state, workspace };
  });
  act(() =>
    h.result.current.workspace.open({
      panel,
      channelId: "alpha",
      target: "info",
    }),
  );
  act(() =>
    h.result.current.workspace.openConversationThread("alpha", "r1", "r1"),
  );
  act(() => h.result.current.state.moveTab("thread:alpha:r1", "main", 0));
  expect(h.result.current.state.selected).toBe("");
  expect(h.result.current.workspace.selectedTab).toBe("info:info");
  act(() => {
    channelTabs(session).open("alpha", "r2");
  });
  expect(h.result.current.workspace.selectedTab).toBe("info:info");
  expect(channelTabs(session).list("alpha")).toEqual([
    { root: "r1", pane: "main", shown: true },
    { root: "r2", pane: "side", shown: false },
  ]);
  act(() => {
    expect(channelTabs(session).close("alpha", "r2")).toBe("closed");
  });
  expect(h.result.current.workspace.selectedTab).toBe("info:info");
});

it("retained offline tabs can close and open threads without activating connected plugins", () => {
  const channels = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ];
  const session = {
    viewer: "viewer",
    channels: {
      list: () => ({ channels }),
      window: () => ({
        rows: [{ id: "root", content: "Original message title" }],
      }),
    },
  } as unknown as RelaySession;
  const panel = { key: "activity", title: "Activity" } as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => panel,
  } as unknown as Panels;
  const snapshot = { status: "connecting", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const h = renderHook(() => {
    const state = useChannelTabState(session, "alpha");
    const workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => false,
      openLink: () => false,
    });
    return { state, workspace };
  });
  const entry = { panel, channelId: "alpha", target: "activity" };
  act(() => h.result.current.workspace.open(entry));
  expect(h.result.current.workspace.items).toHaveLength(1);
  expect(
    h.result.current.workspace.openConversationLink("alpha", "activity"),
  ).toBe(false);
  act(() => h.result.current.workspace.closeTab(entry));
  expect(h.result.current.state.entries).toEqual([]);
  act(() =>
    h.result.current.workspace.openConversationThread("beta", "root", "root"),
  );
  expect(h.result.current.state.tabs).toHaveLength(1);
  act(() => h.result.current.state.openThreadTab("alpha", "reply", "hint"));
  act(() =>
    h.result.current.state.resolveThreadRoot("thread:alpha:hint", "root"),
  );
  const label = () =>
    h.result.current.workspace.items.find(
      (tab) => tab.id === "thread:alpha:hint",
    )?.label;
  expect(label()).toBe("Original message title");
  // A given name replaces the root's text until it is cleared.
  act(() => {
    channelTabs(session).rename("alpha", "root", "Launch plan");
  });
  expect(label()).toBe("Launch plan");
  act(() => {
    channelTabs(session).rename("alpha", "root", "");
  });
  expect(label()).toBe("Original message title");
  const staleOpen = h.result.current.workspace.openConversationThread;
  const staleCloseAll = h.result.current.workspace.closeAllTabs;
  h.unmount();
  act(() => expect(staleCloseAll()).toBe(false));
  act(() => staleOpen("beta", "another-root", "another-root"));
  const restored = renderHook(() => useChannelTabState(session, "alpha"));
  expect(restored.result.current.tabs).toHaveLength(2);
});

it("gives a panel the thread its link was opened from, retargeting a reopened tab", () => {
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }) },
  } as unknown as RelaySession;
  const panel = { key: "profile", title: "Profile" } as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => panel,
  } as unknown as Panels;
  const snapshot = { status: "ready", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const h = renderHook(() =>
    useConversationTabs({
      state: useChannelTabState(session, "alpha"),
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    }),
  );
  const context = () => {
    const [item] = h.result.current.items;
    if (!item) throw new Error("no panel tab");
    return (item.content as { props: { context: PanelContext } }).props.context;
  };
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile", {
      rootId: "first",
    });
  });
  expect(context()).toMatchObject({ channelId: "alpha", rootId: "first" });
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile", {
      rootId: "second",
    });
  });
  expect(h.result.current.items).toHaveLength(1);
  expect(context()).toMatchObject({ rootId: "second" });
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile");
  });
  expect(context()).not.toHaveProperty("rootId");
});

it("a keyboard move focuses the placed tab at once and never takes focus back later", async () => {
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels: [] }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const emptyPanels: RegisteredPanel[] = [];
  const panels = {
    snapshot: () => emptyPanels,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const current = { id: "alpha", name: "Alpha" };
  const h = renderHook(() => {
    const state = useChannelTabState(session, "alpha");
    const workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current,
      channels: [current],
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    });
    return { state, workspace };
  });
  act(() => h.result.current.state.openThreadTab("alpha", "first", "first"));
  act(() => h.result.current.state.openThreadTab("alpha", "second", "second"));
  const strip = document.createElement("div");
  for (const item of h.result.current.workspace.items) {
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.dataset.tabValue = item.id;
    strip.append(tab);
  }
  const elsewhere = document.createElement("button");
  document.body.append(strip, elsewhere);
  const moving = h.result.current.workspace.items[1];
  if (!moving || !("move" in moving)) throw new Error("expected a thread tab");
  act(() => moving.move?.(-1));
  expect(h.result.current.state.tabs.map((tab) => tab.id)).toEqual([
    "thread:alpha:second",
    "thread:alpha:first",
  ]);
  expect(document.activeElement).toBe(strip.lastElementChild);
  // The user moves on before the next frame; that frame must not undo it.
  elsewhere.focus();
  await new Promise((frame) => requestAnimationFrame(frame));
  expect(document.activeElement).toBe(elsewhere);
  strip.remove();
  elsewhere.remove();
});

it("the current verified read-only preview owns its thread host, but unrelated previews do not", () => {
  const current = { id: "preview", name: "Public", readOnly: true as const };
  const other = { id: "other", name: "Other public", readOnly: true as const };
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels: [] }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const emptyPanels: RegisteredPanel[] = [];
  const panels = {
    snapshot: () => emptyPanels,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const h = renderHook(
    ({ cached }) => {
      const state = useChannelTabState(session, "preview");
      const workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current: { ...current, ...(cached ? { cached: true } : {}) },
        channels: [other],
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit: true,
        isLive: () => true,
        openLink: () => false,
      });
      return { state, workspace };
    },
    { initialProps: { cached: false } },
  );
  act(() => h.result.current.state.openThreadTab("preview", "root", "root"));
  expect(h.result.current.workspace.hosts).toHaveLength(1);
  act(() => h.result.current.state.openThreadTab("other", "root", "root"));
  expect(h.result.current.workspace.hosts).toHaveLength(1);
  h.rerender({ cached: true });
  expect(h.result.current.workspace.hosts).toHaveLength(0);
});

it("a tab-placed channel launcher opens one tab beside the threads and toggles it", async () => {
  const user = userEvent.setup();
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: {
      list: () => ({ channels }),
      window: () => ({ rows: [{ id: "root", content: "A thread" }] }),
    },
  } as unknown as RelaySession;
  const panel: RegisteredPanel = {
    id: "work",
    key: "fixture:work",
    pluginId: "fixture",
    revision: "1",
    title: "Work",
    channelPlacement: "tab",
    matches: () => false,
    channelLauncher: ({ toggle, pressed, context }) => (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={() => toggle(context.channelId)}
      >
        Work
      </button>
    ),
    component: () => null,
  };
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => undefined,
  } as unknown as Panels;
  const snapshot = { status: "ready", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  let workspace!: ReturnType<typeof useConversationTabs>;
  let state!: ReturnType<typeof useChannelTabState>;
  function Harness() {
    state = useChannelTabState(session, "alpha");
    workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "wss://relay.example:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    });
    return <>{workspace.drawer.launchers}</>;
  }
  render(<Harness />);
  act(() => state.openThreadTab("alpha", "root", "root", undefined, "side"));
  const launcher = screen.getByRole("button", { name: "Work" });
  expect(launcher).toHaveAttribute("aria-pressed", "false");
  await user.click(launcher);
  expect(workspace.items.map((item) => item.label)).toEqual([
    "A thread",
    "Work",
  ]);
  expect(workspace.selectedTab).toBe(workspace.items[1]?.id);
  expect(state.paneOpen).toBe(true);
  expect(launcher).toHaveAttribute("aria-pressed", "true");
  // The tab gets the full tab context, so the panel can push its own tabs.
  const work = workspace.items[1];
  if (!work) throw new Error("no Work tab");
  const { props } = work.content as {
    props: { context: PanelContext; channelContext: unknown };
  };
  expect(props.channelContext).toMatchObject({ channelId: "alpha" });
  expect(typeof props.context.push).toBe("function");
  // Selecting another tab leaves Work open; the launcher reselects it.
  act(() => workspace.selectPanelTab(workspace.items[0]?.id ?? ""));
  expect(launcher).toHaveAttribute("aria-pressed", "false");
  await user.click(launcher);
  expect(workspace.items).toHaveLength(2);
  expect(launcher).toHaveAttribute("aria-pressed", "true");
  await user.click(launcher);
  expect(workspace.items.map((item) => item.label)).toEqual(["A thread"]);
  expect(launcher).toHaveAttribute("aria-pressed", "false");
});

function launcherHarness(mainPane = false) {
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  let launcher!: ChannelLauncherProps;
  const panel: RegisteredPanel = {
    id: "work",
    key: "fixture:work",
    pluginId: "fixture",
    revision: "1",
    title: "Work",
    channelPlacement: "tab",
    matches: (target) => target.startsWith("work:"),
    channelLauncher: (props) => {
      launcher = props;
      return null;
    },
    component: () => null,
  };
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: (target: string) => (panel.matches(target) ? panel : undefined),
  } as unknown as Panels;
  const snapshot = { status: "ready", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  let workspace!: ReturnType<typeof useConversationTabs>;
  let state!: ReturnType<typeof useChannelTabState>;
  function Harness() {
    state = useChannelTabState(session, "alpha");
    workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "wss://relay.example:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
      mainPane,
    });
    return <>{workspace.drawer.launchers}</>;
  }
  render(<Harness />);
  return {
    panel,
    toggle: (target: string) => act(() => launcher.toggle(target)),
    pressed: () => launcher.pressed,
    entries: () => state.entries,
    workspace: () => workspace,
  };
}

it("a launcher takes over a tab a link already opened for its target", () => {
  const h = launcherHarness();
  act(() => {
    h.workspace().openConversationLink("alpha", "work:a");
  });
  h.toggle("work:a");
  expect(h.entries()).toHaveLength(1);
  expect(h.entries()[0]?.channelContext).toMatchObject({ channelId: "alpha" });
  expect(h.pressed()).toBe(true);
  h.toggle("work:a");
  expect(h.entries()).toHaveLength(0);
});

it.each([
  [
    "a tab's link",
    (h: ReturnType<typeof launcherHarness>) =>
      h.workspace().openConversationLink("alpha", "work:a", { rootId: "root" }),
  ],
  [
    "the timeline",
    (h: ReturnType<typeof launcherHarness>) =>
      h.workspace().open({
        channelId: "alpha",
        rootId: "root",
        panel: h.panel,
        target: "work:a",
      }),
  ],
])(
  "a launcher's tab stays retained when %s reopens its target",
  (_, reopen) => {
    const h = launcherHarness();
    h.toggle("work:a");
    act(() => {
      reopen(h);
    });
    expect(h.entries()).toHaveLength(1);
    expect(h.entries()[0]?.channelContext).toMatchObject({
      channelId: "alpha",
    });
    expect(h.pressed()).toBe(true);
    // A later timeline link elsewhere keeps the retained tab.
    act(() =>
      h
        .workspace()
        .open({ channelId: "alpha", panel: h.panel, target: "work:other" }),
    );
    expect(h.entries().map((entry) => entry.target)).toEqual([
      "work:a",
      "work:other",
    ]);
  },
);

it("a launcher's tab keeps its channel when another conversation opens its target", () => {
  const h = launcherHarness();
  h.toggle("work:a");
  act(() => {
    h.workspace().openConversationLink("beta", "work:a", { rootId: "r" });
  });
  expect(h.entries()).toHaveLength(1);
  expect(h.entries()[0]).toMatchObject({
    channelId: "alpha",
    channelContext: { channelId: "alpha" },
  });
  expect(h.entries()[0]?.rootId).toBeUndefined();
  expect(h.pressed()).toBe(true);
  // A later non-append opening keeps the retained tab.
  act(() => h.workspace().open(undefined));
  expect(h.entries().map((entry) => entry.target)).toEqual(["work:a"]);
});

it("a pushed panel keeps the thread its parent was opened from", () => {
  const h = launcherHarness();
  act(() => {
    h.workspace().openConversationLink("alpha", "work:a", { rootId: "root" });
  });
  const item = h
    .workspace()
    .items.find((item) => item.id === "fixture:work:work:a");
  if (!item) throw new Error("no Work tab");
  const { context } = (item.content as { props: { context: PanelContext } })
    .props;
  act(() => expect(context.push?.("work:b")).toBe(true));
  expect(h.entries().find((entry) => entry.target === "work:b")).toMatchObject({
    channelId: "alpha",
    rootId: "root",
  });
});

it("a launcher whose target changes replaces its one tab in place", () => {
  const h = launcherHarness();
  h.toggle("work:a");
  act(() => {
    h.workspace().openConversationLink("alpha", "work:b");
  });
  act(() => {
    h.workspace().openConversationLink("alpha", "work:c");
  });
  expect(h.pressed()).toBe(false);
  h.toggle("work:b");
  // The link tab for work:b merges into the launcher's tab.
  expect(h.entries().map((entry) => entry.target)).toEqual([
    "work:b",
    "work:c",
  ]);
  expect(h.entries()[0]?.channelContext).toMatchObject({ channelId: "alpha" });
  expect(h.pressed()).toBe(true);
});

// The real state -> workspace -> Tabs boundary owns repeat-open feedback.
// CSS paint is inspected in-browser; here we protect triggering and lifetime.
it.each(["side", "main"] as const)(
  "identifies a reopened %s thread repeatedly without remounting its editor or replaying on history restore",
  async (pane) => {
    const user = userEvent.setup();
    const current = { id: "alpha", name: "Alpha" };
    const session = {
      viewer: "viewer",
      channels: { window: () => ({ rows: [] }) },
    } as unknown as RelaySession;
    const available: RegisteredPanel[] = [];
    const panels = {
      snapshot: () => available,
      subscribe: () => () => {},
    } as unknown as Panels;
    const relay = {
      snapshot: () => ({ status: "ready", session }),
    } as unknown as RelayData;
    function Fixture() {
      const state = useChannelTabState(session, "alpha");
      const workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current,
        channels: [current],
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit: true,
        isLive: () => true,
        openLink: () => false,
        mainPane: true,
      });
      const items = pane === "main" ? workspace.mainItems : workspace.items;
      return (
        <>
          <button
            type="button"
            onClick={() =>
              state.openThreadTab("alpha", "root", "root", "select", pane)
            }
          >
            Open thread
          </button>
          <button
            type="button"
            onClick={() =>
              state.enterVisit("history", {
                channelId: "alpha",
                messageId: "root",
                rootId: "root",
              })
            }
          >
            Restore history
          </button>
          <PanelWorkspace
            main={pane === "main"}
            value={
              pane === "main"
                ? (state.mainSelected ?? "conversation")
                : state.selected
            }
            select={pane === "main" ? state.selectMain : state.select}
            items={[
              ...items.map((item) => ({
                ...item,
                content: <input aria-label="Retained reply" />,
              })),
              { id: "other", label: "Other", content: null },
            ]}
          />
        </>
      );
    }
    const mount = () =>
      render(
        <StrictMode>
          <Fixture />
        </StrictMode>,
      );
    const mounted = mount();
    const open = screen.getByRole("button", { name: "Open thread" });
    fireEvent.click(open);
    const tab = screen.getByRole("tab", { name: "Thread · Alpha" });
    const cue = () => tab.querySelector(".buzz-tabs-attention");
    expect(cue()).toBeNull();
    const editor = screen.getByRole("textbox", { name: "Retained reply" });
    fireEvent.change(editor, { target: { value: "Keep my reply" } });
    editor.focus();
    fireEvent.click(open);
    const first = cue();
    expect(first).not.toBeNull();
    expect(editor).toHaveFocus();
    fireEvent.click(open);
    expect(cue()).not.toBe(first);
    expect(screen.getByRole("tab", { name: "Thread · Alpha" })).toBe(tab);
    expect(screen.getByRole("textbox", { name: "Retained reply" })).toBe(
      editor,
    );
    expect(editor).toHaveValue("Keep my reply");
    const activeCue = cue();
    if (!activeCue) throw new Error("Expected repeat-open feedback");
    fireEvent.animationEnd(activeCue);
    expect(cue()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore history" }));
    expect(cue()).toBeNull();
    const other = screen.getByRole("tab", { name: "Other" });
    await user.click(other);
    expect(other).toHaveAttribute("aria-selected", "true");
    await user.click(tab);
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(cue()).toBeNull();
    expect(other.querySelector(".buzz-tabs-attention")).toBeNull();
    // Retained session counters are not a new request when the page remounts.
    mounted.unmount();
    mount();
    expect(
      screen
        .getByRole("tab", { name: "Thread · Alpha" })
        .querySelector(".buzz-tabs-attention"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(
      screen
        .getByRole("tab", { name: "Thread · Alpha" })
        .querySelector(".buzz-tabs-attention"),
    ).not.toBeNull();
  },
);

it("opens a linked thread from a readable channel through one stable opener", () => {
  setThreadPlacementPreference("main");
  const channels = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
    { id: "gone", name: "Gone", archived: true as const },
  ];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const emptyPanels: RegisteredPanel[] = [];
  const panels = {
    snapshot: () => emptyPanels,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const h = renderHook(() => {
    const state = useChannelTabState(session, "alpha");
    const workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
      mainPane: true,
    });
    return { state, workspace };
  });
  try {
    const open = h.result.current.workspace.openLinkedThread;
    expect(open("gone", "root", "root")).toBe(false);
    expect(open("unknown", "root", "root")).toBe(false);
    expect(h.result.current.state.tabs).toEqual([]);
    let opened: boolean | undefined;
    act(() => {
      opened = open("beta", "reply", "root");
    });
    expect(opened).toBe(true);
    // Another channel's thread never occupies the main pane.
    const [linked] = h.result.current.state.tabs;
    expect(linked).toMatchObject({
      id: "thread:beta:root",
      channelId: "beta",
      messageId: "reply",
    });
    expect(linked && tabPane(linked)).toBe("side");
    expect(h.result.current.state.selected).toBe("thread:beta:root");
    act(() => {
      open("alpha", "own", "own");
    });
    const own = h.result.current.state.tabs[1];
    expect(own && tabPane(own)).toBe("main");
    expect(h.result.current.workspace.openLinkedThread).toBe(open);
    h.unmount();
    expect(open("beta", "later", "later")).toBe(false);
  } finally {
    setThreadPlacementPreference("side");
  }
});

it.each(["linked", "conversation"] as const)(
  "%s thread opening preserves only the selected side panel's context",
  (opener) => {
    setThreadPlacementPreference("main");
    const h = launcherHarness(true);
    const openThread = (root: string) =>
      opener === "linked"
        ? h.workspace().openLinkedThread("alpha", root, root)
        : h.workspace().openConversationThread("alpha", root, root);
    const context = () => {
      const item = h
        .workspace()
        .items.find((item) => item.id === "fixture:work:work:a");
      if (!item) throw new Error("no Work tab");
      return (item.content as { props: { context: PanelContext } }).props
        .context;
    };
    try {
      h.toggle("work:a");
      const panelContext = context();
      act(() => {
        openThread("main-root");
        // The original panel remains active even before React rerenders.
        expect(panelContext.open("work:a")).toBe(true);
      });
      expect(h.workspace().selectedTab).toBe("fixture:work:work:a");
      expect(h.workspace().selectedMain).toBe("thread:alpha:main-root");
      act(() => expect(context().open("work:a")).toBe(true));

      setThreadPlacementPreference("side");
      act(() => openThread("main-root"));
      // Reopening an existing main tab keeps its pane despite the preference.
      expect(h.workspace().selectedMain).toBe("thread:alpha:main-root");
      act(() => expect(context().push?.("work:b")).toBe(true));

      h.toggle("work:a");
      const inactiveContext = context();
      act(() => {
        openThread("side-root");
        expect(inactiveContext.open("work:c")).toBe(false);
      });
      expect(h.workspace().selectedTab).toBe("thread:alpha:side-root");
      h.toggle("work:a");
      setThreadPlacementPreference("main");
      const reselectedContext = context();
      act(() => {
        openThread("side-root");
        // An existing side tab still takes the side selection.
        expect(reselectedContext.push?.("work:c")).toBe(false);
      });
      expect(h.workspace().selectedTab).toBe("thread:alpha:side-root");
      expect(h.workspace().items.map((item) => item.id)).not.toContain(
        "fixture:work:work:c",
      );
    } finally {
      setThreadPlacementPreference("side");
    }
  },
);

// This wiring test uses real tab state, tab menus and channel ownership. Thread
// bodies are irrelevant here; the menu must clear descriptors, not their DOM.
it.each(["main", "side"] as const)(
  "closing all via %s clears both panes, including hidden tabs, only in this channel",
  async (pane) => {
    const user = userEvent.setup();
    const channels = [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ];
    const session = {
      viewer: "viewer",
      channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
    } as unknown as RelaySession;
    const panel: RegisteredPanel = {
      key: "fixture:profile",
      id: "profile",
      pluginId: "fixture",
      revision: "1",
      title: "Profile",
      matches: () => true,
      component: () => null,
    };
    const available = [panel];
    const panels = {
      snapshot: () => available,
      subscribe: () => () => {},
      resolve: () => panel,
    } as unknown as Panels;
    const relay = {
      snapshot: () => ({ status: "connecting", session }),
    } as unknown as RelayData;
    const onCloseThread = vi.fn();
    let state!: ReturnType<typeof useChannelTabState>;
    let beta!: ReturnType<typeof useChannelTabState>;
    let workspace!: ReturnType<typeof useConversationTabs>;
    function Harness() {
      state = useChannelTabState(session, "alpha");
      beta = useChannelTabState(session, "beta");
      workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current: channels[0],
        channels,
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: state.settings ? ["settings"] : [],
        continuingVisit: true,
        isLive: () => false,
        openLink: () => false,
        mainPane: true,
        routed: {
          channelId: "alpha",
          messageId: "first",
          navigation: {} as never,
        },
        onCloseThread,
      });
      const simple = (
        items: { id: string; label: string; close?: () => void }[],
      ) => items.map((item) => ({ ...item, content: null }));
      return (
        <>
          <PanelWorkspace
            main
            label="Channel tabs"
            value={workspace.selectedMain}
            select={(id) =>
              state.selectMain(id === "conversation" ? undefined : id)
            }
            tabMenu={{ key: "alpha", closeAll: workspace.closeAllTabs }}
            items={[
              {
                id: "conversation",
                label: "Alpha",
                content: <p>Channel conversation</p>,
              },
              ...simple(workspace.mainItems),
            ]}
          />
          {state.paneOpen && (
            <PanelWorkspace
              label="Side tabs"
              value={state.selected}
              select={workspace.selectPanelTab}
              tabMenu={{ key: "alpha", closeAll: workspace.closeAllTabs }}
              items={[
                ...(state.settings
                  ? [
                      {
                        id: "settings",
                        label: "Channel settings",
                        content: null,
                      },
                    ]
                  : []),
                ...simple(workspace.items),
              ]}
            />
          )}
        </>
      );
    }
    const view = render(<Harness />);
    act(() => {
      state.openThreadTab("alpha", "first", "first", undefined, "main");
      state.openThreadTab("alpha", "second", "second", undefined, "side");
      workspace.open({ panel, channelId: "alpha", target: "profile" }, true);
      state.setSettings({ channelId: "alpha" });
      beta.openThreadTab("beta", "kept", "kept");
      if (pane !== "side") state.setPaneOpen(false);
    });
    const strip = screen.getByRole("tablist", {
      name: pane === "main" ? "Channel tabs" : "Side tabs",
    });
    const target = within(strip).getAllByRole("tab")[0];
    if (!target) throw new Error("missing tab");
    // Opening the menu on an inactive tab must not select it.
    fireEvent.contextMenu(target);
    const action = await screen.findByRole("menuitem", {
      name: "Close all tabs",
    });
    expect(state.mainSelected).toBe("thread:alpha:first");
    await user.click(action);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Alpha",
    ]);
    expect(state).toMatchObject({
      tabs: [],
      entries: [],
      settings: undefined,
      selected: "",
      mainSelected: undefined,
      paneOpen: false,
    });
    expect(beta.tabs.map((tab) => tab.id)).toEqual(["thread:beta:kept"]);
    const closedSnapshot = state;
    act(() => expect(workspace.closeAllTabs()).toBe(false));
    expect(state).toBe(closedSnapshot);
    expect(onCloseThread).toHaveBeenCalledTimes(1);
    expect(onCloseThread.mock.calls[0]?.[0]).toMatchObject({
      messageId: "first",
    });
    act(() =>
      workspace.open(
        { panel, channelId: "alpha", target: "fresh-profile" },
        true,
      ),
    );
    expect(state.entries.map((entry) => entry.target)).toEqual([
      "fresh-profile",
    ]);
    act(() => expect(workspace.closeAllTabs()).toBe(true));
    // The cleared channel must not recover old descriptors after a page remount.
    view.unmount();
    const restored = renderHook(() => useChannelTabState(session, "alpha"));
    expect(restored.result.current.tabs).toEqual([]);
    expect(restored.result.current.entries).toEqual([]);
  },
);

// Close other tabs shares Close all's owner and scope; only the kept tab stays.
it.each([
  ["a main thread", "Channel tabs", "First"],
  ["a side thread", "Side tabs", "Second"],
  ["a panel", "Side tabs", "Profile"],
  ["settings", "Side tabs", "Channel settings"],
] as const)(
  "closing others from %s keeps it selected and clears the rest of this channel",
  async (_, strip, kept) => {
    const user = userEvent.setup();
    const channels = [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ];
    const rows = [
      { id: "first", content: "First" },
      { id: "second", content: "Second" },
    ];
    const session = {
      viewer: "viewer",
      channels: { list: () => ({ channels }), window: () => ({ rows }) },
    } as unknown as RelaySession;
    const panel: RegisteredPanel = {
      key: "fixture:profile",
      id: "profile",
      pluginId: "fixture",
      revision: "1",
      title: "Profile",
      matches: () => true,
      component: () => null,
    };
    const available = [panel];
    const panels = {
      snapshot: () => available,
      subscribe: () => () => {},
      resolve: () => panel,
    } as unknown as Panels;
    const relay = {
      snapshot: () => ({ status: "connecting", session }),
    } as unknown as RelayData;
    const onCloseThread = vi.fn();
    let state!: ReturnType<typeof useChannelTabState>;
    let beta!: ReturnType<typeof useChannelTabState>;
    let workspace!: ReturnType<typeof useConversationTabs>;
    function Harness() {
      state = useChannelTabState(session, "alpha");
      beta = useChannelTabState(session, "beta");
      workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current: channels[0],
        channels,
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: state.settings ? ["settings"] : [],
        continuingVisit: true,
        isLive: () => false,
        openLink: () => false,
        mainPane: true,
        routed: {
          channelId: "alpha",
          messageId: "first",
          navigation: {} as never,
        },
        onCloseThread,
      });
      const tabMenu = {
        key: "alpha",
        closeAll: workspace.closeAllTabs,
        closeOthers: workspace.closeOtherTabs,
      };
      const simple = (
        items: { id: string; label: string; close?: () => void }[],
      ) => items.map((item) => ({ ...item, content: null }));
      return (
        <>
          <PanelWorkspace
            main
            label="Channel tabs"
            value={workspace.selectedMain}
            select={(id) =>
              state.selectMain(id === "conversation" ? undefined : id)
            }
            tabMenu={tabMenu}
            items={[
              {
                id: "conversation",
                label: "Alpha",
                content: <p>Channel conversation</p>,
              },
              ...simple(workspace.mainItems),
            ]}
          />
          {state.paneOpen && (
            <PanelWorkspace
              label="Side tabs"
              value={workspace.selectedTab}
              select={workspace.selectPanelTab}
              tabMenu={tabMenu}
              items={[
                ...(state.settings
                  ? [
                      {
                        id: "settings",
                        label: "Channel settings",
                        content: null,
                      },
                    ]
                  : []),
                ...simple(workspace.items),
              ]}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    act(() => {
      state.openThreadTab("alpha", "first", "first", undefined, "main");
      state.openThreadTab("alpha", "second", "second", undefined, "side");
      workspace.open({ panel, channelId: "alpha", target: "profile" }, true);
      state.setSettings({ channelId: "alpha" });
      beta.openThreadTab("beta", "other", "other");
    });
    const target = within(
      screen.getByRole("tablist", { name: strip }),
    ).getByRole("tab", { name: kept });
    fireEvent.contextMenu(target);
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(
      kept === "First" || kept === "Second"
        ? ["Rename tab", "Close other tabs", "Close all tabs"]
        : ["Close other tabs", "Close all tabs"],
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Close other tabs" }),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Alpha",
      kept,
    ]);
    const tab = screen.getByRole("tab", { name: kept });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(state.thread).toBeUndefined();
    // The routed thread is retired only when it is one of those closed.
    expect(onCloseThread).toHaveBeenCalledTimes(kept === "First" ? 0 : 1);
    expect(beta.tabs.map((item) => item.id)).toEqual(["thread:beta:other"]);
    // Nothing else is left to close; the repeat changes nothing.
    const closedSnapshot = state;
    act(() =>
      expect(
        workspace.closeOtherTabs(
          tab.getAttribute("data-tab-value") ?? "missing",
        ),
      ).toBe(false),
    );
    expect(state).toBe(closedSnapshot);
    if (kept !== "First") return;
    // With nothing else to close, an inactive kept thread is still selected.
    act(() => state.selectMain(undefined));
    expect(tab).toHaveAttribute("aria-selected", "false");
    fireEvent.contextMenu(tab);
    await user.click(
      await screen.findByRole("menuitem", { name: "Close other tabs" }),
    );
    expect(screen.getByRole("tab", { name: kept })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: kept })).toHaveFocus();
  },
);

it.each([
  [true, "main"],
  // Channels between resolved channels keeps other threads beside it.
  [false, "side"],
])(
  "anyMainThread %s places another channel's thread in %s",
  (anyMainThread, pane) => {
    setThreadPlacementPreference("main");
    const channels = [{ id: "alpha", name: "Alpha" }];
    const session = {
      viewer: "viewer",
      channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
    } as unknown as RelaySession;
    const available: RegisteredPanel[] = [];
    const panels = {
      snapshot: () => available,
      subscribe: () => () => {},
    } as unknown as Panels;
    const relay = {
      snapshot: () => ({ status: "ready", session }),
    } as unknown as RelayData;
    const h = renderHook(() => {
      const state = useChannelTabState(session, undefined, "page:fixture");
      const workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current: undefined,
        channels,
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit: true,
        mainPane: true,
        anyMainThread,
        isLive: () => true,
        openLink: () => false,
      });
      return { state, workspace };
    });
    act(() => {
      h.result.current.workspace.openLinkedThread("alpha", "r1", "r1");
    });
    expect(h.result.current.state.tabs.map(tabPane)).toEqual([pane]);
  },
);

it("mounts a hidden thread tab when first shown and keeps it for the visit", () => {
  setThreadPlacementPreference("side");
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const emptyPanels: RegisteredPanel[] = [];
  const panels = {
    snapshot: () => emptyPanels,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const h = renderHook(
    ({ continuingVisit }) => {
      const state = useChannelTabState(session, "alpha");
      const workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current: channels[0],
        channels,
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit,
        isLive: () => true,
        openLink: () => false,
      });
      return { state, workspace };
    },
    { initialProps: { continuingVisit: true } },
  );
  act(() => h.result.current.state.openThreadTab("alpha", "r1", "r1"));
  act(() => h.result.current.state.openThreadTab("alpha", "r2", "r2"));
  expect(h.result.current.workspace.hosts).toHaveLength(2);
  h.rerender({ continuingVisit: false });
  expect(h.result.current.workspace.hosts).toHaveLength(1);
  h.rerender({ continuingVisit: true });
  act(() => h.result.current.state.select("thread:alpha:r1"));
  expect(h.result.current.workspace.hosts).toHaveLength(2);
  act(() => h.result.current.state.select("thread:alpha:r2"));
  expect(h.result.current.workspace.hosts).toHaveLength(2);
  const restored = (id: string) =>
    (
      h.result.current.workspace.hosts.find(
        (host) => (host as { key?: string }).key === id,
      ) as unknown as {
        children: {
          props: { children: { props: { restored?: unknown } } };
        };
      }
    ).children.props.children.props.restored;
  expect(restored("thread:alpha:r1")).toBeDefined();
  // A closed tab reopened in the same visit asks afresh.
  act(() =>
    h.result.current.workspace.items
      .find((item) => item.id === "thread:alpha:r1")
      ?.close?.(),
  );
  act(() => h.result.current.state.openThreadTab("alpha", "r1", "r1"));
  expect(restored("thread:alpha:r1")).toBeUndefined();
});
