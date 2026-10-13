// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
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
