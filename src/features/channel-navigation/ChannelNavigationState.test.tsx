// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { PanelWorkspace } from "../panels/PanelWorkspace";
import {
  ChannelNavigationProvider,
  useChannelNavigation,
  useChannelMenuActions,
} from "./ChannelNavigationState";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture() {
  let ids = ["existing"];
  // This UI handoff provider consumes only the roster, never a command writer.
  const session = () =>
    ({
      channels: { list: () => ({ channels: ids.map((id) => ({ id })) }) },
    }) as unknown as RelaySession;
  let snapshot: RelaySnapshot = {
    status: "ready",
    scope: "community:viewer",
    viewer: "viewer",
    generation: 1,
    session: session(),
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as RelayData;
  return {
    relay,
    roster: (next: string[]) => {
      ids = next;
    },
    replace() {
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        session: session(),
      };
      for (const listener of listeners) listener();
    },
  };
}
function mount(relay: RelayData) {
  return renderHook(
    () => {
      const value = useChannelNavigation();
      if (!value) throw new Error("Missing channel navigation provider");
      return value;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <ChannelNavigationProvider relay={relay}>
            {children}
          </ChannelNavigationProvider>
        </StrictMode>
      ),
    },
  );
}
it("captures the roster before DM preparation and preserves it across participant changes", () => {
  const h = fixture();
  const view = mount(h.relay);
  act(() => {
    view.result.current?.prepareDm(["peer"]);
    h.roster(["existing", "new"]);
  });
  expect(view.result.current.preparingDm?.existing).toEqual(
    new Set(["existing"]),
  );
  expect(view.result.current.preparingDm?.members).toEqual(
    new Set(["viewer", "peer"]),
  );
  act(() => view.result.current?.prepareDm(["other"]));
  expect(view.result.current.preparingDm?.existing).toEqual(
    new Set(["existing"]),
  );
  expect(view.result.current.preparingDm?.members).toEqual(
    new Set(["viewer", "other"]),
  );
  act(() => view.result.current?.clearPreparingDm());
  expect(view.result.current.preparingDm).toBeUndefined();
});
it("resets transient handoffs and rejects retired callbacks on session replacement", () => {
  const h = fixture();
  const view = mount(h.relay);
  act(() => {
    view.result.current?.prepareDm(["peer"]);
    view.result.current.openLifecycle(
      { id: "channel", name: "Channel" },
      "leave",
    );
  });
  const retired = view.result.current;
  retired.activityThread.current = {
    channelId: "channel",
    messageId: "root",
    entryId: "visit",
    signal: new AbortController().signal,
    trigger: null,
  };
  retired.activityAgent.current = {
    channelId: "channel",
    agent: "agent",
    trigger: null,
  };
  act(() => h.replace());
  expect(view.result.current.preparingDm).toBeUndefined();
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  expect(view.result.current.activityThread.current).toBeUndefined();
  expect(view.result.current.activityAgent.current).toBeUndefined();
  act(() => {
    retired.prepareDm(["late"]);
    retired.openLifecycle({ id: "late", name: "Late" }, "leave");
  });
  expect(view.result.current.preparingDm).toBeUndefined();
  expect(view.result.current.lifecycleDialog).toBeUndefined();
});

it("hands both entrances to one confirmation and preserves its origin until closed", () => {
  const h = fixture();
  const view = mount(h.relay);
  const channel = { id: "channel", name: "Channel" };
  const trigger = document.createElement("button");
  act(() => view.result.current.openLifecycle(channel, "leave", trigger));
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "leave",
    trigger,
  });
  act(() =>
    view.result.current.openLifecycle({ id: "other", name: "Other" }, "delete"),
  );
  expect(view.result.current.lifecycleDialog?.channel).toBe(channel);
  act(() => view.result.current.closeLifecycle());
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  act(() => view.result.current.openLifecycle(channel, "archive"));
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "archive",
  });
});

it("retains the settings tab close control when an archive action remounts", () => {
  const view = mount(fixture().relay);
  const content = (archived: boolean) => (
    <PanelWorkspace
      value="settings"
      select={() => {}}
      items={[
        {
          id: "settings",
          label: "Channel settings",
          close: () => {},
          content: (
            <aside aria-label="Channel settings">
              <button type="button">Canvas</button>
              <button key={String(archived)} type="button">
                {archived ? "Unarchive channel" : "Archive channel"}
              </button>
            </aside>
          ),
        },
      ]}
    />
  );
  const panel = render(content(false));
  const trigger = panel.getByRole("button", { name: "Archive channel" });
  const close = panel.getByRole("button", {
    name: "Close Channel settings tab",
  });
  act(() =>
    view.result.current.openLifecycle(
      { id: "channel", name: "Channel" },
      "archive",
      trigger,
    ),
  );
  panel.rerender(content(true));
  expect(trigger.isConnected).toBe(false);
  expect(view.result.current.lifecycleDialog?.focusFallback).toBe(close);
  expect(close.isConnected).toBe(true);
});

it("publishes sidebar actions to a sibling menu and retires them with the session", () => {
  const h = fixture();
  const view = renderHook(
    () => ({
      handoff: useChannelNavigation(),
      actions: useChannelMenuActions(),
    }),
    {
      wrapper: ({ children }) => (
        <ChannelNavigationProvider relay={h.relay}>
          {children}
        </ChannelNavigationProvider>
      ),
    },
  );
  const retired = view.result.current.handoff?.menuActions;
  if (!retired) throw new Error("Missing navigation provider");
  const actions = () => ["Mute"];
  act(() => retired.publish(actions));
  expect(view.result.current.actions).toBe(actions);
  act(() => h.replace());
  expect(view.result.current.actions).toBeUndefined();
  act(() => retired.publish(() => ["stale"]));
  expect(view.result.current.actions).toBeUndefined();
  act(() => view.result.current.handoff?.menuActions.publish(actions));
  expect(view.result.current.actions).toBe(actions);
  act(() => view.result.current.handoff?.menuActions.publish(undefined));
  expect(view.result.current.actions).toBeUndefined();
});

it("retires only the originating header confirmation and rejects its deferred reopening", () => {
  const h = fixture();
  const view = mount(h.relay);
  const channel = { id: "channel", name: "Channel" };
  const origin = new AbortController();
  act(() =>
    view.result.current.openLifecycle(
      channel,
      "delete",
      undefined,
      origin.signal,
    ),
  );
  expect(view.result.current.lifecycleDialog?.origin).toBe(origin.signal);
  act(() => origin.abort());
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  act(() =>
    view.result.current.openLifecycle(
      channel,
      "delete",
      undefined,
      origin.signal,
    ),
  );
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  const old = new AbortController();
  act(() =>
    view.result.current.openLifecycle(channel, "delete", undefined, old.signal),
  );
  act(() => view.result.current.closeLifecycle());
  act(() => view.result.current.openLifecycle(channel, "archive"));
  act(() => old.abort());
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "archive",
  });
});
