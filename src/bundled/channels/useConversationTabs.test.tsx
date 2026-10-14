// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type {
  PanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

afterEach(cleanup);
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
  expect(
    h.result.current.workspace.items.find(
      (tab) => tab.id === "thread:alpha:hint",
    )?.label,
  ).toBe("Original message title");
  const staleOpen = h.result.current.workspace.openConversationThread;
  h.unmount();
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
