// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { SoloWorkspaces } from "./SoloWorkspaces";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  cleanup();
  localStorage.clear();
});

function fixture(projectName = "Work") {
  const owner = createRelaySession(null);
  owners.push(owner);
  let saved: SidebarPreferences = {
    sections: [{ id: "work", name: projectName, order: 0 }],
    assignments: {},
    starred: [],
    muted: [],
  };
  const write = vi.fn(
    async (intent: {
      channelId: string;
      sectionId?: string;
      createSection?: { id: string; name: string };
    }) => {
      if (intent.createSection)
        saved = {
          ...saved,
          sections: [...saved.sections, { ...intent.createSection, order: 1 }],
        };
      const assignments = { ...saved.assignments };
      const target = intent.createSection?.id ?? intent.sectionId;
      if (target) assignments[intent.channelId] = target;
      else delete assignments[intent.channelId];
      saved = { ...saved, assignments };
      return saved;
    },
  );
  const remove = vi.fn(async (id: string) => {
    saved = {
      ...saved,
      sections: saved.sections.filter((project) => project.id !== id),
      assignments: Object.fromEntries(
        Object.entries(saved.assignments).filter(
          ([, project]) => project !== id,
        ),
      ),
    };
    return saved;
  });
  const store = () =>
    createSidebarPreferencesStore({
      read: async () => saved,
      available: true,
      write,
      writeStar: async () => [],
      removeSection: remove,
      // Groups-only chats have no Messages sort coordinate.
      groupsOnly: true,
    });
  const onNew = vi.fn();
  const channels = {
    status: "ready",
    channels: [
      { id: "chat", name: "Planning", channelType: "solo" },
      { id: "other", name: "Existing chat", channelType: "solo" },
    ],
  };
  const view = (
    preferences: ReturnType<typeof store>["queries"],
    scope = "viewer:community",
    unread: unknown = owner.session.unread,
  ) => (
    <SoloWorkspaces
      onNew={onNew}
      session={
        {
          ...owner.session,
          soloPreferences: preferences,
          unread,
          canvas: { available: false },
          channels: { list: () => channels, subscribeList: () => () => {} },
        } as unknown as RelaySession
      }
      scope={scope}
      chats={[
        { id: "chat", title: "Planning" },
        { id: "other", title: "Existing chat" },
      ]}
      renderChat={(item) => <button type="button">{item.title}</button>}
    />
  );
  return {
    store,
    view,
    write,
    remove,
    onNew,
    saved: () => saved,
  };
}

it("creates and moves through the relay service, then restores in a fresh store", async () => {
  const h = fixture();
  const first = h.store();
  const user = userEvent.setup();
  const mounted = render(h.view(first.queries));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Planning" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Chat settings…" }),
  ).toHaveAttribute("aria-disabled", "true");
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitem", { name: "New workspace…" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Workspace name" }),
    "Projects",
  );
  await user.click(screen.getByRole("button", { name: "Create and move" }));
  await waitFor(() =>
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "chat",
        createSection: expect.objectContaining({ name: "Projects" }),
      }),
      expect.objectContaining({ aborted: false }),
    ),
  );
  await waitFor(() =>
    expect(screen.queryByText("Saving workspace…")).toBeNull(),
  );
  expect(h.saved().assignments.chat).toBe(h.saved().sections[1]?.id);
  mounted.unmount();
  first.dispose();
  const second = h.store();
  render(h.view(second.queries, "other-device"));
  const project = await screen.findByRole("button", { name: "Projects" });
  expect(project.parentElement?.parentElement).toHaveTextContent("Planning");
  fireEvent.click(project);
  expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
  expect(screen.getByRole("button", { name: "Existing chat" })).toBeVisible();
  second.dispose();
});

it("rolls back a rejected move and keeps retry available", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  h.write.mockRejectedValueOnce(new Error("Relay unavailable"));
  render(h.view(store.queries));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for Planning" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Relay unavailable")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Chats" }).parentElement?.parentElement,
  ).toHaveTextContent("Planning");
  await user.click(screen.getByRole("button", { name: "Retry move" }));
  await waitFor(() => expect(h.saved().assignments.chat).toBe("work"));
  await waitFor(() =>
    expect(screen.queryByText("Relay unavailable")).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: "Work" }).parentElement?.parentElement,
  ).toHaveTextContent("Planning");
  store.dispose();
});

it("keeps chats after project deletion and allows retry after a rejected deletion", async () => {
  const h = fixture();
  const owner = h.store();
  const user = userEvent.setup();
  await owner.queries.ensure();
  await owner.queries.assign("chat", "work");
  render(h.view(owner.queries));
  h.remove.mockRejectedValueOnce(new Error("Deletion unavailable"));
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workspace" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Deletion unavailable",
  );
  expect(screen.getByRole("button", { name: "Work" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workspace" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Planning" })).toBeVisible();
  expect(h.saved().assignments).toEqual({});
  owner.dispose();
});

it("starts an unfiled chat from the Chats heading plus without collapsing it", async () => {
  const h = fixture();
  const owner = h.store();
  render(h.view(owner.queries));
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "New chat in Chats" }),
  );
  expect(h.onNew).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  owner.dispose();
});

it("copies the chat link", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<ToastProvider>{h.view(h.store().queries)}</ToastProvider>);
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Copy" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy link to chat" }),
  );
  expect(write).toHaveBeenCalledWith("buzz://channel/chat");
});

it("reports a clipboard failure without claiming success", async () => {
  const h = fixture();
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  render(<ToastProvider>{h.view(h.store().queries)}</ToastProvider>);
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Copy" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy chat ID" }),
  );
  expect(
    await screen.findByText("Couldn’t copy. Try again from the chat menu."),
  ).toBeVisible();
});

it("only offers Chats as a destination from a project", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const store = h.store();
  render(h.view(store.queries));
  const openProjectMenu = async () => {
    await user.click(
      await screen.findByRole("button", { name: "Actions for Planning" }),
    );
    (await screen.findByRole("menuitem", { name: "Move to" })).focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("menuitem", { name: "New workspace…" });
  };
  await openProjectMenu();
  expect(screen.queryByRole("menuitem", { name: "Chats" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Work" }));
  await waitFor(() => expect(h.saved().assignments.chat).toBe("work"));
  await openProjectMenu();
  await user.click(screen.getByRole("menuitem", { name: "Chats" }));
  await waitFor(() => expect(h.saved().assignments.chat).toBeUndefined());
  store.dispose();
});

it("starts a chat in a project from its heading plus", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  render(h.view(store.queries));
  try {
    const heading = await screen.findByRole("button", { name: "Work" });
    const header = heading.parentElement;
    if (!header) throw new Error("Missing project header");
    await user.click(
      within(header).getByRole("button", { name: "New chat in Work" }),
    );
    expect(h.onNew).toHaveBeenCalledExactlyOnceWith("work");
  } finally {
    store.dispose();
  }
});

it("opens the exact project from an empty project's New chat row", async () => {
  const projectName =
    "A very long project name that should not become the new chat label";
  const h = fixture(projectName);
  const store = h.store();
  const user = userEvent.setup();
  render(h.view(store.queries, "empty-project"));
  try {
    const choices = await screen.findAllByRole("button", {
      name: `New chat in ${projectName}`,
    });
    const row = choices.find((choice) => choice.textContent === "New chat");
    expect(row).toBeDefined();
    if (!row) throw new Error("Missing empty project action");
    row.focus();
    await user.keyboard("{Enter}");
    expect(h.onNew).toHaveBeenCalledExactlyOnceWith("work");
  } finally {
    store.dispose();
  }
});

it("marks a chat read from its row menu and reports a failed save", async () => {
  const h = fixture();
  const store = h.store();
  const user = userEvent.setup();
  const markChannelRead = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read state unavailable"))
    .mockResolvedValue(undefined);
  const snapshot = (channelId: string, observedCount: number) => ({
    target: { kind: "channel", channelId },
    observedCount,
    attentionCount: 0,
    manual: "none",
    coverage: "observed",
    freshness: "observed",
  });
  const unreadChat = snapshot("chat", 3);
  const readChat = snapshot("other", 0);
  const unread = {
    sync: () => ({ capability: "frontier-sync" }),
    snapshot: (target: { channelId: string }) =>
      target.channelId === "chat" ? unreadChat : readChat,
    subscribe: () => () => {},
    markChannelRead,
    markUnreadLocal: vi.fn(),
  };
  render(h.view(store.queries, "viewer:community", unread));
  try {
    const actions = screen.getByRole("button", {
      name: "Actions for Planning",
    });
    await user.click(actions);
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as Read" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Read state unavailable",
    );
    await user.click(actions);
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as Read" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(markChannelRead).toHaveBeenNthCalledWith(2, "chat");
  } finally {
    store.dispose();
  }
});
