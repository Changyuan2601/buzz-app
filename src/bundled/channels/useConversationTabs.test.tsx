import { createDraftGuard } from "../../features/drafts/guard";
import { DraftProtection } from "../../features/drafts/DraftProtection";
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

afterEach(cleanup);
it("retained offline tabs can close, add and open threads without activating connected plugins", () => {
  const channels = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }) },
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
  act(() => h.result.current.workspace.addTab());
  expect(h.result.current.state.tabs).toHaveLength(1);
  act(() =>
    h.result.current.workspace.openConversationThread("beta", "root", "root"),
  );
  expect(h.result.current.state.tabs).toHaveLength(2);
  const staleAdd = h.result.current.workspace.addTab;
  h.unmount();
  act(() => staleAdd());
  const restored = renderHook(() => useChannelTabState(session, "alpha"));
  expect(restored.result.current.tabs).toHaveLength(2);
});

it("cancels closing a dirty profile and only discards the replaced transient panel", async () => {
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
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const guard = createDraftGuard();
  const h = renderHook(
    () => {
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
      });
      return { state, workspace };
    },
    {
      wrapper: ({ children }) => (
        <DraftProtection guard={guard}>{children}</DraftProtection>
      ),
    },
  );
  const entry = { panel, channelId: "alpha", target: "profile" };
  const retained = {
    panel,
    channelId: "alpha",
    target: "tool",
    channelContext: {
      scope: "scope:viewer",
      channelId: "alpha",
      channelName: "Alpha",
      viewer: "viewer",
      relayUrl: "wss://example.invalid",
    },
  };
  act(() => {
    h.result.current.workspace.open(entry);
    h.result.current.workspace.open(retained, true);
  });
  const reset = vi.fn(),
    keep = vi.fn();
  guard
    .register(entry, "profile", reset)
    .update({ dirty: true, saving: false });
  guard
    .register(retained, "retained tool", keep)
    .update({ dirty: true, saving: false });
  act(() => h.result.current.workspace.closeTab(entry));
  expect(h.result.current.state.entries).toContain(entry);
  await act(async () => guard.cancel());
  expect(h.result.current.state.entries).toContain(entry);
  act(() =>
    h.result.current.workspace.open({
      panel,
      channelId: "alpha",
      target: "other",
    }),
  );
  await act(async () => guard.discard());
  expect(h.result.current.state.entries).not.toContain(entry);
  expect(h.result.current.state.entries).toContain(retained);
  expect(reset).toHaveBeenCalledOnce();
  expect(keep).not.toHaveBeenCalled();
  h.unmount();
  guard.dispose();
});
