// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { MeSidebar } from "./MeSidebar";
import { meTarget } from "./routes";
import {
  defaultAssistant,
  readWelcome,
  saveDefaultAssistant,
  saveWelcome,
} from "../../features/sessions/welcome";

stubAvatarBrowserApis();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const agent = "a".repeat(64);
const outsider = "b".repeat(64);
const viewer = "c".repeat(64);
const root = "d".repeat(64);
const scope = `https://relay.test:${viewer}`;
function fixture() {
  const owner = createRelaySession(null);
  owners.push(owner);
  const base = owner.session;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  let typing: ReturnType<RelaySession["typing"]["snapshot"]> = [];
  let activity: ReturnType<RelaySession["agentActivity"]["snapshot"]> = {
    ...base.agentActivity.snapshot(),
    status: "disabled",
  };
  let unread: ReturnType<RelaySession["unread"]["snapshot"]> = {
    target: { kind: "channel", channelId: id },
    observedCount: 2,
    attentionCount: 1,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
  };
  let threads: ReturnType<RelaySession["unread"]["activity"]> = {
    channelId: id,
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const markThrough = vi.fn(async () => ({
    operationId: "read",
    durability: "saved" as const,
    sync: "pending" as const,
  }));
  const list = {
    status: "ready" as const,
    channels: [
      { id, name: "Planning", channelType: "session" as const },
      { id: other, name: "Other", channelType: "session" as const },
    ],
  };
  const placement = {
    ...base.mePlacement.snapshot(),
    status: "ready" as const,
    entries: [
      {
        eventId: "e".repeat(64),
        createdAt: 1,
        record: {
          version: 2 as const,
          community: "https://relay.test",
          deleted: false,
          value: {
            type: "groups" as const,
            id: "me" as const,
            groups: [],
            assignments: {},
            channels: [id, other],
          },
        },
      },
    ],
  };
  const preferences = {
    status: "ready" as const,
    data: { sections: [], assignments: {}, starred: [], muted: [] },
  };
  const choices = {
    ...base.agentChoices.snapshot(),
    identities: [{ pubkey: agent, name: "Owned Agent", managed: true }],
  } satisfies ReturnType<RelaySession["agentChoices"]["snapshot"]>;
  const profiles = new Map([
    [agent, { name: "Owned Agent", isAgent: true as const }],
    [outsider, { name: "Outside Agent", isAgent: true as const }],
  ]);
  const session: RelaySession = {
    ...base,
    viewer,
    channels: { ...base.channels, list: () => list, ensureList() {} },
    mePlacement: {
      ...base.mePlacement,
      snapshot: () => placement,
      ensure() {},
    },
    mePreferences: {
      ...base.mePreferences,
      snapshot: () => preferences,
      ensure: async () => {},
    },
    typing: { ...base.typing, snapshot: () => typing, subscribe },
    agentActivity: {
      ...base.agentActivity,
      snapshot: () => activity,
      subscribe,
      subscribeWorking: subscribe,
      workingSnapshot: () =>
        JSON.stringify(
          activity.turns
            .filter((turn) => turn.state === "working")
            .map((turn) => turn.channelId),
        ),
    },
    agentChoices: { ...base.agentChoices, snapshot: () => choices },
    profiles: { ...base.profiles, snapshot: () => profiles },
    unread: {
      ...base.unread,
      snapshot: () => unread,
      subscribe: (_target, listener) => subscribe(listener),
      activity: () => threads,
      subscribeActivity: (_id, listener) => subscribe(listener),
      markThrough,
    },
  };
  const snapshot = { status: "ready" as const, session, generation: 1, scope };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = {
    open,
    snapshot: () => ({ attempt: { signal: new AbortController().signal } }),
  } as unknown as Navigation;
  const target = meTarget(scope, other);
  const publish = () => {
    for (const listener of listeners) listener();
  };
  render(
    <ChannelNavigationProvider relay={relay}>
      <MeSidebar relay={relay} navigator={navigator} target={target} />
    </ChannelNavigationProvider>,
  );
  return {
    open,
    markThrough,
    listeners,
    typing(next: typeof typing) {
      act(() => {
        typing = next;
        publish();
      });
    },
    activity(next: typeof activity) {
      act(() => {
        activity = next;
        publish();
      });
    },
    threads(next: typeof threads) {
      act(() => {
        threads = next;
        publish();
      });
    },
    clearUnread() {
      act(() => {
        unread = { ...unread, observedCount: 0, attentionCount: 0 };
        publish();
      });
    },
    activitySnapshot: activity,
  };
}
it.each([false, true])(
  "opens Welcome in the selected relay with completed setup=%s without changing another relay or existing chats/default",
  async (complete) => {
    const saved = {
      channelId: id,
      agent,
      type: "claude/claude",
      complete: true,
    };
    const otherScope = `https://other-relay.test:${viewer}`;
    saveWelcome(otherScope, saved);
    if (complete) saveWelcome(scope, saved);
    saveDefaultAssistant(scope, agent);
    const f = fixture();
    await userEvent.click(
      screen.getByRole("button", { name: "Restart welcome" }),
    );
    if (complete) {
      expect(readWelcome(scope)).toEqual(saved);
      await userEvent.click(
        within(
          screen.getByRole("alertdialog", { name: "Restart welcome?" }),
        ).getByRole("button", { name: "Restart welcome" }),
      );
    }
    expect(f.open).toHaveBeenLastCalledWith(meTarget(scope, "welcome"));
    expect(readWelcome(scope)).toBeUndefined();
    expect(readWelcome(otherScope)).toEqual(saved);
    expect(defaultAssistant(scope)).toBe(agent);
    expect(screen.getByRole("button", { name: /^Planning/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Other/ })).toBeVisible();
  },
);

it("offers restart during customization, preserves it on Cancel, and resets only after confirmation", async () => {
  const saved = {
    channelId: id,
    agent,
    type: "claude/claude",
    replyId: root,
    kickoff: "observed" as const,
  };
  saveWelcome(scope, saved);
  const f = fixture();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Restart welcome" });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(readWelcome(scope)).toEqual(saved);
  expect(f.open).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Restart welcome",
    }),
  );
  expect(readWelcome(scope)).toBeUndefined();
  expect(f.open).toHaveBeenLastCalledWith(meTarget(scope, "welcome"));
});

it("keeps restart visible but unavailable while setup has no confirmed welcome", () => {
  const saved = { channelId: id, type: "claude/claude", creatingAgent: true };
  saveWelcome(scope, saved);
  const f = fixture();
  expect(
    screen.getByRole("button", { name: "Restart welcome" }),
  ).toBeDisabled();
  expect(readWelcome(scope)).toEqual(saved);
  expect(f.open).not.toHaveBeenCalled();
});

it("keeps unread state while owned thread typing and observer working signals start and stop", () => {
  const f = fixture();
  expect(screen.getByRole("img", { name: "Berd" })).toBeVisible();
  const row = screen.getByRole("button", { name: /^Planning/ });
  expect(
    row.querySelector('[data-channel-unread-title="true"]'),
  ).toBeInTheDocument();
  expect(row.querySelector("[data-channel-priority]")).toBeInTheDocument();
  f.typing([{ channelId: id, threadRootId: root, pubkey: outsider }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: other, pubkey: agent }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: id, threadRootId: root, pubkey: agent }]);
  expect(
    within(row).getByRole("img", { name: "Owned Agent working in Planning" }),
  ).toBeInTheDocument();
  expect(row.querySelector("[data-channel-priority]")).toBeInTheDocument();
  expect(row).toHaveAccessibleName(/observed unread messages/);
  expect(row).toHaveAccessibleName(/Owned Agent working in Planning/);
  f.activity({
    ...f.activitySnapshot,
    status: "listening",
    turns: [
      {
        channelId: id,
        agent,
        turnId: "one",
        timestamp: Date.now(),
        state: "working",
      },
    ],
  });
  expect(row.querySelectorAll("[data-channel-working]")).toHaveLength(1);
  f.typing([]);
  expect(within(row).getByRole("img", { name: /working/ })).toBeInTheDocument();
  f.activity(f.activitySnapshot);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  expect(row.querySelector("[data-channel-priority]")).toBeInTheDocument();
  f.clearUnread();
  expect(row.querySelector("[data-channel-unread]")).toBeNull();
  cleanup();
  expect(f.listeners.size).toBe(0);
});
it("offers unread thread navigation and mark-read through the shared activity popover", async () => {
  const f = fixture();
  const user = userEvent.setup();
  f.threads({
    channelId: id,
    items: [
      {
        channelId: id,
        rootId: root,
        latestMessageId: "e".repeat(64),
        authorId: agent,
        preview: "Needs review",
        unreadCount: 1,
        createdAt: 1,
      },
    ],
    coverage: "observed",
    freshness: "observed",
  });
  const row = screen.getByRole("button", { name: /^Planning/ });
  row.focus();
  await user.keyboard("{Enter}");
  const popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", {
      name: "Mark thread from Owned Agent as read",
    }),
  );
  expect(f.markThrough).toHaveBeenCalledWith(
    { kind: "thread", channelId: id, rootId: root },
    "e".repeat(64),
  );
  await user.click(
    within(popup).getByRole("button", {
      name: "Open unread thread from Owned Agent: Needs review",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: id,
      messageId: root,
    }),
  );
});
it("opens a typing-only agent's profile activity in its Me conversation", async () => {
  const f = fixture();
  f.typing([{ channelId: id, pubkey: agent }]);
  const user = userEvent.setup();
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  let popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", { name: "View Owned Agent activity" }),
  );
  expect(f.open).toHaveBeenLastCalledWith(meTarget(scope, id));
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", {
      name: "Open conversation for Owned Agent in Planning",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(meTarget(scope, id));
});

it.each(["disconnected", "connecting", "error"] as const)(
  "keeps Solo's brand visible while %s without offering unavailable chat creation",
  (status) => {
    const owner = createRelaySession(null);
    owners.push(owner);
    const snapshot = { status, generation: 1, scope, session: owner.session };
    const relay: RelayData = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      async clearCache() {},
    };
    // No navigation is needed until the connected history is mounted.
    const navigator = { open: vi.fn() } as unknown as Navigation;
    render(
      <MeSidebar
        relay={relay}
        navigator={navigator}
        target={meTarget(scope)}
      />,
    );
    const sidebar = screen.getByRole("complementary", { name: "Solo sidebar" });
    expect(within(sidebar).getByRole("img", { name: "Berd" })).toBeVisible();
    expect(within(sidebar).getByRole("status")).toHaveTextContent(
      "Connect to a community",
    );
    expect(
      within(sidebar).queryByRole("button", { name: "New chat" }),
    ).toBeNull();
  },
);
