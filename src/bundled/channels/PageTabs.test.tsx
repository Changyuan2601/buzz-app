// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationTab as Tab } from "./useChannelTabState";
import { PageTabs, type PageTabOptions, type PageTabTarget } from "./PageTabs";

// The tab's own conversation has its mounted suite; this owner places it.
vi.mock("./ConversationTab", () => ({
  ConversationTab: ({
    tab,
    channel,
  }: {
    tab: Tab;
    channel: { name: string };
  }) => (
    <p
      data-message={tab.messageId}
      data-reveal={tab.revealRequest}
      data-mark-read={tab.kind === "conversation" ? tab.markRead : undefined}
    >
      {tab.kind} in {channel.name}
    </p>
  ),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function fixture() {
  const channels = [
    { id: "alpha", name: "alpha" },
    { id: "beta", name: "beta" },
    { id: "pending", name: "pending", cached: true },
  ];
  const list = { channels };
  const rows = { rows: [{ id: "root", content: "Root text" }] };
  const profiles = new Map();
  const available: never[] = [];
  const session = {
    viewer: "viewer",
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
      window: () => rows,
    },
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
  } as unknown as RelaySession;
  const connection = { status: "ready", session };
  const host = {
    relay: { snapshot: () => connection },
    panels: {
      snapshot: () => available,
      subscribe: () => () => {},
      resolve: () => undefined,
    },
    navigation: { open: vi.fn() },
  } as unknown as ConversationHostServices;
  let open: (target: PageTabTarget, options?: PageTabOptions) => boolean = () =>
    false;
  const openers = new Set<typeof open>();
  render(
    <PageTabs
      id="switchboard"
      session={session}
      scope="origin:viewer"
      label="Switchboard"
      host={host}
      extensions={{} as ConversationExtensions}
    >
      {(next) => {
        open = next;
        openers.add(next);
        return <p>Session list</p>;
      }}
    </PageTabs>,
  );
  return {
    openers,
    open(target: PageTabTarget, options?: PageTabOptions) {
      let opened = false;
      act(() => {
        opened = open(target, options);
      });
      return opened;
    },
  };
}
const tabs = (name: string) =>
  within(screen.getByRole("tablist", { name }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

const side = () => {
  const list = screen
    .getAllByRole("tablist")
    .find((item) => item.getAttribute("aria-label") !== "Switchboard tabs");
  return within(list as HTMLElement)
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
};

it("keeps the page in view, opening threads in the side pane", () => {
  setThreadPlacementPreference("main");
  const page = fixture();
  expect(screen.getByText("Session list")).toBeVisible();
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard"]);
  expect(side()).toEqual(["Root text"]);
  expect(screen.getByText("Session list")).toBeVisible();
  expect(screen.getByText("thread in alpha")).toBeVisible();
});

it("replaces the last opened tab unless asked to keep it", () => {
  const page = fixture();
  expect(page.open({ channelId: "missing" })).toBe(false);
  // Membership a cached channel has not confirmed cannot show a tab.
  expect(page.open({ channelId: "pending" })).toBe(false);
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(side()).toEqual(["Root text"]);
  expect(page.open({ channelId: "beta" }, { keep: true })).toBe(true);
  expect(page.open({ channelId: "alpha" })).toBe(true);
  expect(side()).toEqual(["beta", "alpha"]);
  // Opening a kept tab's conversation again selects it in place.
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(side()).toEqual(["beta", "alpha"]);
  expect(screen.getByText("conversation in beta")).toBeVisible();
  // Pages can depend on one opener across the renders its tabs cause.
  expect(page.openers.size).toBe(1);
});

it("opens a thread moved to the main pane where it is", () => {
  const page = fixture();
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  act(() => {
    fireEvent.keyDown(screen.getByRole("tab", { name: /Root text/ }), {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });
  });
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
});

it("opens at a message, asking again on each open, with the page's read choice", () => {
  const page = fixture();
  expect(
    page.open({ channelId: "beta", messageId: "post" }, { markRead: false }),
  ).toBe(true);
  const tab = () => screen.getByText("conversation in beta");
  expect(tab()).toHaveAttribute("data-message", "post");
  expect(tab()).toHaveAttribute("data-reveal", "1");
  expect(tab()).toHaveAttribute("data-mark-read", "false");
  // The same message again reveals it again; a later open sets the read choice.
  page.open({ channelId: "beta", messageId: "post" }, { markRead: false });
  expect(tab()).toHaveAttribute("data-reveal", "2");
  page.open({ channelId: "beta" });
  expect(tab()).not.toHaveAttribute("data-message");
  expect(tab()).not.toHaveAttribute("data-mark-read");
  expect(side()).toEqual(["beta"]);
});

it("opens a thread at one of its messages", () => {
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  const thread = () => screen.getByText("thread in alpha");
  expect(thread()).toHaveAttribute("data-message", "reply");
  expect(thread()).toHaveAttribute("data-reveal", "1");
  // Each open at a message asks the reader to show it again.
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  expect(thread()).toHaveAttribute("data-reveal", "2");
  // Opening the thread itself asks for no reveal.
  page.open({ channelId: "alpha", threadId: "root" });
  expect(thread()).toHaveAttribute("data-message", "root");
  expect(thread()).toHaveAttribute("data-reveal", "2");
});
