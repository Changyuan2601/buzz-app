// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { ChannelList } from "../../features/relay/contracts";
import { SessionsPage } from "./SessionsPage";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it.each([false, true])(
  "shows initial session loading only without retained sessions (retained=%s)",
  (retained) => {
    const owner = createRelaySession(null);
    const list: ChannelList = {
      status: "loading",
      channels: retained
        ? [{ id: "session", name: "Planning", channelType: "session" }]
        : [],
    };
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        list: () => list,
        ensureList() {},
      },
    };
    const snapshot = {
      status: "ready" as const,
      generation: 1,
      scope: "loading-test",
      session,
    };
    const relay: RelayData = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      async clearCache() {},
    };
    const empty = { snapshot: () => [], subscribe: () => () => {} };
    try {
      render(
        <SessionsPage
          relay={relay}
          extensions={{ tools: empty, inline: empty }}
        />,
      );
      if (retained) {
        expect(screen.getByRole("button", { name: "Planning" })).toBeVisible();
        expect(screen.queryByText("Loading sessions…")).toBeNull();
      } else expect(screen.getByText("Loading sessions…")).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("hides parent-linked sessions even when restored as the selected session", () => {
  const owner = createRelaySession(null);
  const list: ChannelList = {
    status: "ready",
    channels: [
      {
        id: "linked",
        name: "Hidden child",
        channelType: "session",
        parentChannelId: "parent",
      },
      { id: "standalone", name: "Standalone", channelType: "session" },
    ],
  };
  localStorage.setItem(
    'buzz-view.v1:["filter-test","sessions:selected"]',
    '"linked"',
  );
  const session = {
    ...owner.session,
    channels: { ...owner.session.channels, list: () => list, ensureList() {} },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: "filter-test",
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const empty = { snapshot: () => [], subscribe: () => () => {} };
  try {
    render(
      <SessionsPage
        relay={relay}
        extensions={{ tools: empty, inline: empty }}
      />,
    );
    expect(screen.queryByText("Hidden child")).toBeNull();
    expect(screen.getByRole("button", { name: "Standalone" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "New session" })).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens an unfinished session through its original setup receipt even after its section was deleted", () => {
  const owner = createRelaySession(null);
  const id = "22222222-2222-4222-8222-222222222222";
  const scope = "pending-test";
  const list: ChannelList = {
    status: "ready",
    channels: [{ id, name: "Partially created", channelType: "session" }],
  };
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, "sessions:selected"])}`,
    JSON.stringify(id),
  );
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, "sessions:section:deleted:pending"])}`,
    JSON.stringify({
      id,
      text: "Recover this first message",
      creationId: "c".repeat(64),
      setup: {
        sectionId: "deleted",
        canvas: "Frozen instructions",
        agents: [],
      },
    }),
  );
  const session = {
    ...owner.session,
    channels: { ...owner.session.channels, list: () => list, ensureList() {} },
  };
  const snapshot = { status: "ready" as const, generation: 1, scope, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const empty = { snapshot: () => [], subscribe: () => () => {} };
  try {
    render(
      <SessionsPage
        relay={relay}
        extensions={{ tools: empty, inline: empty }}
      />,
    );
    expect(screen.getByRole("region", { name: "New session" })).toBeVisible();
    expect(screen.queryByText("Loading messages…")).toBeNull();
    expect(screen.getByRole("heading", { name: "New session" })).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});
