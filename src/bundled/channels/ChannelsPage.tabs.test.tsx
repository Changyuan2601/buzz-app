// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import closeRequest from "../../../src-tauri/src/close-request.js?raw";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { matchesEvent } from "../../features/relay/projection";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { writeView } from "../../shared/view-state";
import { useChannelTabState } from "./useChannelTabState";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import { SOLO_LABEL } from "../../features/solo/labels";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ChannelsPage } from "./ChannelsPage";

composerDOMFixture();

const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  // jsdom has no layout/ResizeObserver. Only geometry is substituted; the page,
  // composer, session, tab store and menu interaction are production owners.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  setThreadPlacementPreference("side");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function page(type: "stream" | "solo" = "stream") {
  const viewer = keypair(),
    authority = keypair();
  const channelId = "alpha";
  const events = [
    roster(authority, channelId, [viewer.pubkey]),
    metadata(
      authority,
      channelId,
      "Alpha",
      undefined,
      type === "solo"
        ? [["t", "stream"], ["private"], ["t", SOLO_LABEL]]
        : [["t", "stream"]],
    ),
  ];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      query: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  const scope = `https://relay.test:${viewer.pubkey}`;
  writeView(scope, "selected-channel", channelId);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const panel: RegisteredPanel = {
    id: "notes",
    key: "fixture:notes",
    pluginId: "fixture",
    revision: "1",
    title: "Notes",
    matches: () => false,
    channelPlacement: "tab",
    channelLauncher: ({ context, toggle }) => (
      <button type="button" onClick={() => toggle(context.channelId)}>
        Open notes
      </button>
    ),
    component: () => <input aria-label="Notes draft" />,
  };
  const available = [panel];
  const panels: Panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => undefined,
    register() {},
  };
  render(<ChannelsPage relay={relay} panels={panels} />);
  const user = userEvent.setup();
  const composer = await screen.findByRole("textbox", {
    name: type === "solo" ? "Message your agents" : "Message #Alpha",
  });
  const open = () =>
    user.click(screen.getByRole("button", { name: "Open notes" }));
  return { user, composer, open, session: owner.session };
}

const closeTabs = (tabEvent = "buzz:close-all-tabs") => {
  let handled = false;
  act(() => {
    handled =
      new Function(
        "window",
        "document",
        "Event",
        "tabEvent",
        `return eval(${JSON.stringify(closeRequest)})`,
      )(window, document, Event, tabEvent) === "handled";
  });
  return handled;
};

it.each(["stream", "solo"] as const)(
  "the real %s page closes its side tabs by shortcut, preserves typing, and handles an empty repeat",
  async (type) => {
    const h = await page(type);
    await h.open();
    expect(
      screen.getByRole("tab", {
        name: "Notes",
      }),
    ).toBeInTheDocument();
    h.composer.focus();
    await h.user.keyboard("Keep typing");
    const modal = document.createElement("dialog");
    modal.open = true;
    document.body.append(modal);
    closeTabs();
    modal.remove();
    expect(
      screen.getByRole("tab", {
        name: "Notes",
      }),
    ).toBeInTheDocument();
    expect(closeTabs()).toBe(true);
    expect(
      screen.queryByRole("tab", {
        name: "Notes",
      }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    expect(h.composer).toHaveTextContent("Keep typing");
    closeTabs();
    expect(h.composer).toHaveFocus();
    expect(h.composer).toHaveTextContent("Keep typing");
  },
);

it.each(["stream", "solo"] as const)(
  "the real %s page returns focus when the menu's owning tab closes",
  async (type) => {
    const h = await page(type);
    await h.open();
    const notes = screen.getByRole("tab", {
      name: "Notes",
    });
    await h.user.pointer({ target: notes, keys: "[MouseRight]" });
    await h.user.click(
      await screen.findByRole("menuitem", { name: "Close all tabs" }),
    );
    expect(
      screen.queryByRole("tab", {
        name: "Notes",
      }),
    ).not.toBeInTheDocument();
    if (type === "stream")
      expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
    else
      expect(screen.getByRole("region", { name: "Chat Alpha" })).toHaveFocus();
  },
);

it("an empty tab menu returns keyboard focus to its surviving tab", async () => {
  const h = await page();
  const channel = within(
    screen.getByRole("tablist", { name: "Channel tabs" }),
  ).getByRole("tab", { name: "Alpha" });
  channel.focus();
  await h.user.keyboard("{Shift>}{F10}{/Shift}");
  const action = await screen.findByRole("menuitem", {
    name: "Close all tabs",
  });
  action.focus();
  await h.user.keyboard("{Enter}");
  expect(await screen.findByRole("tab", { name: "Alpha" })).toHaveFocus();
  expect(screen.getAllByRole("tab")).toHaveLength(1);
});

it("the main tab's menu clears the real page's side tabs too", async () => {
  const h = await page();
  await h.open();
  const channel = within(
    screen.getByRole("tablist", { name: "Channel tabs" }),
  ).getByRole("tab", { name: "Alpha" });
  await h.user.pointer({ target: channel, keys: "[MouseRight]" });
  await h.user.click(
    await screen.findByRole("menuitem", { name: "Close all tabs" }),
  );
  expect(screen.queryByRole("tab", { name: "Notes" })).not.toBeInTheDocument();
  expect(channel).toHaveFocus();
});

it("close-all works while a main-pane thread covers the channel conversation", async () => {
  const h = await page();
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "a".repeat(64);
  act(() =>
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "main"),
  );
  expect(
    within(screen.getByRole("tablist", { name: "Channel tabs" })).getAllByRole(
      "tab",
    ),
  ).toHaveLength(2);
  expect(closeTabs()).toBe(true);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
});

it.each([false, true])(
  "closing a side tab from the composer keeps typing and Enter there (another side tab=%s)",
  async (anotherTab) => {
    const h = await page();
    if (anotherTab) {
      const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
      const root = "b".repeat(64);
      act(() =>
        tabs.result.current.openThreadTab(
          "alpha",
          root,
          root,
          undefined,
          "side",
        ),
      );
    }
    await h.open();
    expect(screen.getByRole("tab", { name: "Notes" })).toBeInTheDocument();
    h.composer.focus();
    expect(closeTabs("buzz:close-active-tab")).toBe(true);
    expect(
      screen.queryByRole("tab", { name: "Notes" }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    await h.user.keyboard("{Enter}");
    expect(
      screen.queryByRole("tab", { name: "Notes" }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    await h.user.keyboard("Keep typing");
    expect(h.composer).toHaveTextContent("Keep typing");
  },
);

it.each(["side", "main"] as const)(
  "closing others from a %s tab keeps focus on it while the other pane's selected tab closes",
  async (kept) => {
    const h = await page();
    const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
    const root = "c".repeat(64);
    act(() =>
      tabs.result.current.openThreadTab("alpha", root, root, undefined, "main"),
    );
    await h.open();
    const main = within(screen.getByRole("tablist", { name: "Channel tabs" }));
    const thread = main.getAllByRole("tab")[1];
    if (!thread) throw new Error("missing main-pane thread tab");
    expect(thread).toHaveAttribute("aria-selected", "true");
    const target =
      kept === "side" ? screen.getByRole("tab", { name: "Notes" }) : thread;
    await h.user.pointer({ target, keys: "[MouseRight]" });
    await h.user.click(
      await screen.findByRole("menuitem", { name: "Close other tabs" }),
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(target).toBeInTheDocument();
    expect(target).toHaveAttribute("aria-selected", "true");
    expect(target).toHaveFocus();
  },
);
