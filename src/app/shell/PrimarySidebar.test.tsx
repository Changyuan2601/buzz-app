// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { readView, writeView } from "../../shared/view-state";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";

import { fixture, owners, id, viewer, scope } from "./sidebar-testing";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
it("filters the combined sidebar without navigating or resetting Solo sections", async () => {
  const user = userEvent.setup();
  const f = fixture(true);
  const all = screen.getByRole("tab", { name: "All" });
  const solo = screen.getByRole("tab", { name: "Solo" });
  const team = screen.getByRole("tab", { name: "Team" });
  expect(all).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "New" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(
    screen.getAllByRole("separator", { name: "Resize sidebar" }),
  ).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Chats" }));
  await user.click(team);
  expect(
    screen.queryByRole("button", { name: "New chat" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(screen.getByRole("tabpanel", { name: "Team" })).toHaveAttribute(
    "id",
    team.getAttribute("aria-controls"),
  );
  await user.click(solo);
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await user.keyboard("{ArrowRight}");
  expect(team).toHaveFocus();
  expect(solo).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Enter}");
  expect(team).toHaveAttribute("aria-selected", "true");
  await user.click(all);
  expect(f.open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "New" }));
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["New chat", "New workspace", "New DM", "New channel"]);
  await user.click(screen.getByRole("menuitem", { name: "New chat" }));
  expect(f.open).toHaveBeenCalledWith(soloDraftTarget(scope));
  await user.click(solo);
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(await screen.findByRole("menuitem", { name: "New DM" }));
  expect(f.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: { viewer, communityOrigin: "https://relay.test" },
    route: { version: 1, params: "new-message" },
  });
});

it.each([
  ["New workspace", "New workspace", "Cancel"],
  ["New channel", "Create a channel", "Close channel creation"],
])(
  "opens %s from any filter and returns focus to New on cancel",
  async (item, title, close) => {
    const user = userEvent.setup();
    fixture(true, true);
    await user.click(screen.getByRole("tab", { name: "Team" }));
    const trigger = screen.getByRole("button", { name: "New" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const dialog = await screen.findByRole("dialog", { name: title });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("textbox", { name: "Name" }),
      ).toHaveFocus(),
    );
    await user.click(within(dialog).getByRole("button", { name: close }));
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("keeps unavailable creation actions disabled", async () => {
  const user = userEvent.setup();
  fixture(true);
  await user.click(screen.getByRole("button", { name: "New" }));
  expect(
    await screen.findByRole("menuitem", { name: "New workspace" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitem", { name: "New channel" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it.each([
  ["New", "New workspace"],
  ["New in Solo", "New workspace…"],
])(
  "does not navigate to a replaced session after project creation from %s completes",
  async (triggerName, itemName) => {
    const f = fixture(true, true);
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = vi
      .spyOn(f.session.soloPreferences, "createSection")
      .mockReturnValue(pending);
    await user.click(screen.getByRole("button", { name: triggerName }));
    await user.click(await screen.findByRole("menuitem", { name: itemName }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name" }),
      "Planning",
    );
    try {
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      f.replaceSession();
    } finally {
      await act(async () => {
        finish();
        await pending;
      });
    }
    expect(f.open).not.toHaveBeenCalled();
  },
);

it("retains scope across Settings remounts and reveals navigation outside the filter", async () => {
  const f = fixture(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Team" }));
  f.sidebar(false);
  f.sidebar(true);
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  f.navigate(soloDraftTarget(scope));
  expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  f.navigate({
    version: 1,
    kind: "conversation",
    channelId: "team-channel",
    scope: { viewer, communityOrigin: "https://relay.test" },
  });
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "All" }));
  f.navigate(conversationTarget(scope, id));
  expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it.each([
  ["New workspace", "New workspace"],
  ["New channel", "Create a channel"],
])(
  "retains typed %s input through cached reconnect and session replacement",
  async (item, title) => {
    const f = fixture(true, true);
    const user = userEvent.setup();
    f.connection({ status: "connecting", cached: true });
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const input = within(
      await screen.findByRole("dialog", { name: title }),
    ).getByRole("textbox", { name: "Name" });
    await user.type(input, "Keep this draft");
    f.connection({ status: "error" });
    expect(input).toHaveValue("Keep this draft");
    f.replaceSession();
    expect(
      within(screen.getByRole("dialog", { name: title })).getByRole("textbox", {
        name: "Name",
      }),
    ).toHaveValue("Keep this draft");
  },
);

it("keeps navigation scope preferences partitioned by community", async () => {
  const f = fixture(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Team" }));
  const second = `https://second.test:${viewer}`;
  f.connection({ scope: second, session: { ...f.session, scope: second } });
  expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Solo" }));
  f.connection({ scope, session: f.session });
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("header channel creation expands the saved destination without changing other collapsed sections", async () => {
  writeView(scope, "channel-sidebar", {
    collapsed: ["channels", "starred"],
    width: 280,
  });
  const f = fixture(true, true);
  const create = vi
    .spyOn(f.session.channelCreation, "create")
    .mockResolvedValue("new-channel");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "New channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Create a channel",
  });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  await user.click(
    within(dialog).getByRole("button", { name: /^Create channel$/ }),
  );
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "conversation",
        channelId: "new-channel",
      }),
    ),
  );
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    collapsed: ["starred"],
    width: 280,
  });
});

it("reveals Solo when New chat reopens the same destination after filtering it out", async () => {
  const f = fixture(true);
  const user = userEvent.setup();
  f.navigate(soloDraftTarget(scope));
  await user.click(screen.getByRole("tab", { name: "Team" }));
  expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
  expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

const soloFailure = vi.hoisted(() => ({ active: false }));
vi.mock("../../features/channel-navigation/SoloInventory", async (original) => {
  const actual =
    await original<
      typeof import("../../features/channel-navigation/SoloInventory")
    >();
  return {
    ...actual,
    SoloInventory: (props: Parameters<typeof actual.SoloInventory>[0]) => {
      if (soloFailure.active) throw new Error("Solo inventory failed");
      return <actual.SoloInventory {...props} />;
    },
  };
});

it("contains a Solo render failure without rendering the failed inventory in its fallback", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  soloFailure.active = true;
  try {
    fixture(true);
    expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversations couldn’t open.",
    );
    soloFailure.active = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry sidebar" }));
    expect(
      await screen.findByRole("navigation", { name: "Solo conversations" }),
    ).toBeVisible();
  } finally {
    soloFailure.active = false;
    consoleError.mockRestore();
  }
});

it("does not reveal or open a channel when its creation completes in a replaced session", async () => {
  writeView(scope, "channel-sidebar", {
    collapsed: ["channels", "starred"],
    width: 280,
  });
  const f = fixture(true, true);
  let finish!: (id: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const create = vi
    .spyOn(f.session.channelCreation, "create")
    .mockReturnValue(pending);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "New channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Create a channel",
  });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Planning",
  );
  try {
    await user.click(
      within(dialog).getByRole("button", { name: /^Create channel$/ }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    f.replaceSession();
  } finally {
    await act(async () => {
      finish("new-channel");
      await pending;
    });
  }
  expect(f.open).not.toHaveBeenCalled();
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    collapsed: ["channels", "starred"],
    width: 280,
  });
});

it.each(["empty", "chats", "projects", "both"])(
  "keeps Solo creation available with %s, including the Solo filter",
  async (inventory) => {
    const user = userEvent.setup();
    const f = fixture(true, true);
    const channels = f.session.channels.list();
    const preferences = f.session.soloPreferences.snapshot();
    vi.spyOn(f.session.channels, "list").mockReturnValue({
      ...channels,
      channels:
        inventory === "empty" || inventory === "projects"
          ? []
          : channels.channels,
    });
    vi.spyOn(f.session.soloPreferences, "snapshot").mockReturnValue({
      ...preferences,
      data: {
        sections:
          inventory === "projects" || inventory === "both"
            ? [{ id: "project", name: "Work", order: 0 }]
            : [],
        assignments: {},
        starred: [],
        muted: [],
      },
    });
    f.connection({});
    const nav = screen.getByRole("navigation", { name: "Solo conversations" });
    if (inventory === "empty") {
      await user.click(within(nav).getByRole("button", { name: "New chat" }));
      expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
    }
    await user.click(screen.getByRole("tab", { name: "Solo" }));
    const trigger = within(nav).getByRole("button", { name: "New in Solo" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
    expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "New workspace…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("keeps new Solo chats available when project creation is unavailable", async () => {
  const user = userEvent.setup();
  const f = fixture(true);
  await user.click(screen.getByRole("button", { name: "New in Solo" }));
  expect(
    await screen.findByRole("menuitem", { name: "New workspace…" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("menuitem", { name: "New chat" }));
  expect(f.open).toHaveBeenLastCalledWith(soloDraftTarget(scope));
});
