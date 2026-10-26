// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import userEvent from "@testing-library/user-event";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { bindNames } from "../../features/identity-names/service";
import {
  profileTarget,
  profileActivityViewTarget,
} from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";

import { agentDirectory } from "../../features/identity-names/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import { keypair, profile } from "../../features/relay/testing";

const key = "a".repeat(64);
afterEach(cleanup);
it("updates a mounted profile from the shared name view without replacing its identity", async () => {
  let name = "Local name";
  let notify = () => {};
  const owner = createRelaySession(null, {
    identityNames: {
      register() {},
      bind(source) {
        return bindNames(source, {
          snapshot: () => [
            {
              id: "test",
              activate() {
                return undefined;
              },
              scope: () => () => ({ name }),
            },
          ],
          subscribe(listener) {
            notify = listener;
            return () => {};
          },
        });
      },
    },
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    const presenceStatus = vi
      .spyOn(owner.session.presence, "status")
      .mockReturnValue("online");
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(key) ?? ""}
        close={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Presence:/ })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: `${name} avatar, online` }),
    ).toHaveLength(1);
    expect(document.querySelector(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Channels" }));
    expect(
      screen.getByRole("img", { name: `${name} avatar, online` }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(screen.queryByRole("img", { name: /^Presence:/ })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: `${name} avatar, online` }),
    ).toHaveLength(1);
    act(() => {
      name = "Edited name";
      notify();
    });
    expect(screen.getByRole("heading", { name })).toBeTruthy();
    for (const [status, label] of [
      ["away", "Away"],
      ["offline", "Offline"],
    ] as const) {
      presenceStatus.mockReturnValue(status);
      act(() => {
        name = `${label} name`;
        notify();
      });
      expect(screen.getByText(label, { exact: true })).toBeVisible();
      expect(
        screen.getByRole("img", { name: `${name} avatar, ${status}` }),
      ).toBeTruthy();
      expect(screen.queryByText("Active", { exact: true })).toBeNull();
    }
    presenceStatus.mockReturnValue("unknown");
    act(() => {
      name = "Unknown status name";
      notify();
    });
    expect(screen.getByRole("img", { name: `${name} avatar` })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    expect(document.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
      "data-status",
    );
    expect(screen.queryByText(/^(Active|Away|Offline)$/)).toBeNull();
    expect(owner.session.profiles.snapshot().size).toBe(0);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it("recovers provider-owned names in the same live session and releases demand when disabled", async () => {
  const person = keypair();
  const relayKey = keypair();
  const publicProfile = profile(person, { name: "Public Carl" });
  let live!: LiveCallbacks;
  let entries = [agentDirectory];
  let changed = () => {};
  const read = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey: person.pubkey, name: "Configured Carl" }],
  }));
  const owner = createRelaySession(
    {
      viewer: person.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "wss://relay.example.test",
      query: async (filters) =>
        filters.some((filter) => filter.kinds?.includes(0))
          ? [publicProfile]
          : [],
      media: () => undefined,
      readAgentLibrary: read,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      identityNames: {
        register() {},
        bind(source) {
          return bindNames(source, {
            snapshot: () => entries,
            subscribe(listener) {
              changed = listener;
              return () => {};
            },
          });
        },
      },
    },
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const reconnect = () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established();
  };
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(person.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Configured Carl" });
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(person.pubkey)?.name).toBe(
        "Public Carl",
      ),
    );
    act(() => live.state({ status: "connected", routes: [] }));
    act(() => live.state({ status: "retrying", routes: [] }));
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
    expect(read).toHaveBeenCalledTimes(1);
    act(() => {
      live.state({ status: "connected", routes: [] });
      live.established();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    act(() => {
      entries = [];
      changed();
      reconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    act(() => {
      entries = [agentDirectory];
      changed();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(3);
    owner.dispose();
    act(reconnect);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it("exposes thinking through the named profile avatar across tabs", async () => {
  const agent = keypair();
  const owner = createRelaySession({
    viewer: key,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [
      profile(agent, { name: "Thinking agent", is_agent: true }),
    ],
  });
  await owner.session.profiles.ensure([agent.pubkey]);
  vi.spyOn(owner.session.presence, "status").mockReturnValue("online");
  let activity = owner.session.agentActivity.snapshot();
  const listeners = new Set<() => void>();
  const session = {
    ...owner.session,
    agentActivity: {
      ...owner.session.agentActivity,
      snapshot: () => activity,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Thinking agent" }),
    ).toBeTruthy();
    const details = screen.getByRole("region", { name: "Profile details" });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, available" }),
    ).toBeVisible();
    act(() => {
      activity = {
        ...activity,
        turns: [
          {
            agent: agent.pubkey,
            channelId: "alpha",
            turnId: "one",
            timestamp: 0,
            state: "working",
          },
        ],
      };
      for (const listener of listeners) listener();
    });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, thinking" }),
    ).toBeVisible();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Channels" }));
    // The first channel list changes access, which clears cached profiles;
    // the rest of the app reads them again.
    await act(() => owner.session.profiles.ensure([agent.pubkey]));
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, thinking" }),
    ).toBeVisible();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    act(() => {
      activity = { ...activity, turns: [] };
      for (const listener of listeners) listener();
    });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, available" }),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

function renderAgentActivity(
  tabs: { title: string; role?: string }[],
  rootId?: string,
) {
  const owner = createRelaySession(null);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const type = {
    key: "test/echo",
    title: "Echo",
    tabs: tabs.map(({ title, role }) => ({
      id: title.toLowerCase(),
      title,
      role,
      component: ({
        conversation,
      }: {
        conversation?: { channelId: string; rootId?: string };
      }) => (
        <>
          <p>Echo {title.toLowerCase()}</p>
          {conversation && (
            <p>
              Opened from {conversation.channelId}/
              {conversation.rootId ?? "channel"}
            </p>
          )}
        </>
      ),
    })),
  } as unknown as RegisteredAgentType;
  const agent = {
    key,
    pubkey: key,
    name: "Echo",
    type: type.key,
    place: "here",
    config: {},
    attention: {},
  } as unknown as Agent;
  const types = [type];
  const agentsSnapshot = { agents: [agent], teams: [] };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => agentsSnapshot,
    types: () => types,
    find: (pubkey: string) => (pubkey === key ? agent : undefined),
    memberships: () => [],
  } as unknown as Agents;
  render(
    <ProfilePanel
      relay={relay}
      agents={agents}
      target={profileActivityViewTarget(key) ?? ""}
      context={{
        channelId: "originating-channel",
        ...(rootId && { rootId }),
        canOpen: () => true,
        open: vi.fn(() => true),
      }}
      close={() => {}}
    />,
  );
  return () => {
    cleanup();
    owner.dispose();
  };
}

it("opens an agent's activity on its type's Activity tab, the profile's only one", async () => {
  const dispose = renderAgentActivity(
    [
      { title: "Settings", role: "settings" },
      { title: "Activity", role: "activity" },
    ],
    "thread-root",
  );
  try {
    expect(
      screen.getByRole("tab", { name: "Activity", selected: true }),
    ).toBeVisible();
    // The originating thread reaches the tab that selects its session.
    expect(
      screen.getByText("Opened from originating-channel/thread-root"),
    ).toBeVisible();
    expect(screen.getAllByRole("tab", { name: "Activity" })).toHaveLength(1);
    expect(screen.getByText("Echo activity")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByText("Echo settings")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Echo activity")).toBeVisible();
  } finally {
    dispose();
  }
});

it("opens an agent's activity on its type's first tab when the type has no Activity tab", () => {
  const dispose = renderAgentActivity([
    { title: "Settings", role: "settings" },
    { title: "Logs" },
  ]);
  try {
    expect(
      screen.getByRole("tab", { name: "Identity", selected: true }),
    ).toBeVisible();
    expect(screen.getByText("Echo settings")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
  } finally {
    dispose();
  }
});
