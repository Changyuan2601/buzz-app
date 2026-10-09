// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import type { RelaySession } from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { SessionSections } from "./SessionSections";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function fixture() {
  let saved: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
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
      sections: saved.sections.filter((section) => section.id !== id),
      assignments: Object.fromEntries(
        Object.entries(saved.assignments).filter(
          ([, section]) => section !== id,
        ),
      ),
    };
    return saved;
  });
  const store = () =>
    createSidebarPreferencesStore(
      async () => saved,
      true,
      write,
      async () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      remove,
    );
  const onNew = vi.fn();
  const channels = { status: "ready", channels: [] };
  const view = (
    preferences: ReturnType<typeof store>["queries"],
    scope = "viewer:community",
  ) => (
    <SessionSections
      onNew={onNew}
      session={
        {
          sidebarPreferences: preferences,
          canvas: { available: false },
          channels: { list: () => channels, subscribeList: () => () => {} },
        } as unknown as RelaySession
      }
      scope={scope}
      sessions={[
        { id: "session", title: "Planning" },
        {
          id: "linked",
          title: "Existing linked session",
          parentName: "Parent",
        },
      ]}
      renderSession={(item) => <button type="button">{item.title}</button>}
    />
  );
  return { store, view, write, remove, onNew, saved: () => saved };
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
    screen.queryByRole("menuitem", { name: "Session settings…" }),
  ).toBeNull();
  (await screen.findByRole("menuitem", { name: "Section" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitem", { name: "New section…" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Section name" }),
    "Projects",
  );
  await user.click(screen.getByRole("button", { name: "Create and move" }));
  await waitFor(() =>
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "session",
        createSection: expect.objectContaining({ name: "Projects" }),
      }),
      expect.objectContaining({ aborted: false }),
    ),
  );
  await waitFor(() => expect(screen.queryByText("Saving section…")).toBeNull());
  expect(h.saved().assignments.session).toBe(h.saved().sections[1]?.id);
  mounted.unmount();
  first.dispose();
  const second = h.store();
  render(h.view(second.queries, "other-device"));
  const section = await screen.findByRole("button", { name: "Projects" });
  expect(section.parentElement?.parentElement).toHaveTextContent("Planning");
  fireEvent.click(section);
  expect(screen.queryByRole("button", { name: "Planning" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Existing linked session" }),
  ).toBeVisible();
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
  (await screen.findByRole("menuitem", { name: "Section" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Relay unavailable")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Sessions" }).parentElement
      ?.parentElement,
  ).toHaveTextContent("Planning");
  await user.click(screen.getByRole("button", { name: "Retry move" }));
  await waitFor(() => expect(h.saved().assignments.session).toBe("work"));
  await waitFor(() =>
    expect(screen.queryByText("Relay unavailable")).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: "Work" }).parentElement?.parentElement,
  ).toHaveTextContent("Planning");
  store.dispose();
});

it("keeps sessions after section deletion and allows retry after a rejected deletion", async () => {
  const h = fixture();
  const owner = h.store();
  const user = userEvent.setup();
  await owner.queries.ensure();
  await owner.queries.assign("session", "work");
  render(h.view(owner.queries));
  h.remove.mockRejectedValueOnce(new Error("Deletion unavailable"));
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete section" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Deletion unavailable",
  );
  expect(screen.getByRole("button", { name: "Work" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete section" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Planning" })).toBeVisible();
  expect(h.saved().assignments).toEqual({});
  owner.dispose();
});

it("starts an unfiled session from the Sessions heading plus without collapsing it", async () => {
  const h = fixture();
  const owner = h.store();
  render(h.view(owner.queries));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New session" }));
  expect(h.onNew).toHaveBeenCalledWith(undefined);
  expect(
    screen.queryByRole("button", { name: "New session in Sessions" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  owner.dispose();
});

it.each([
  ["Copy session name", "Planning"],
  ["Copy session ID", "session"],
  ["Copy link to session", "buzz://channel/session"],
])("copies the session value for %s", async (label, expected) => {
  const h = fixture();
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<ToastProvider>{h.view(h.store().queries)}</ToastProvider>);
  await user.click(
    await screen.findByRole("button", { name: "Actions for Planning" }),
  );
  (await screen.findByRole("menuitem", { name: "Copy" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: label }));
  expect(write).toHaveBeenCalledWith(expected);
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
    await screen.findByRole("menuitem", { name: "Copy session ID" }),
  );
  expect(
    await screen.findByText("Couldn’t copy. Try again from the session menu."),
  ).toBeVisible();
});

it("only offers Sessions as a destination from a custom section", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const store = h.store();
  render(h.view(store.queries));
  const openSectionMenu = async () => {
    await user.click(
      await screen.findByRole("button", { name: "Actions for Planning" }),
    );
    (await screen.findByRole("menuitem", { name: "Section" })).focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("menuitem", { name: "New section…" });
  };
  await openSectionMenu();
  expect(screen.queryByRole("menuitem", { name: "Sessions" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Work" }));
  await waitFor(() => expect(h.saved().assignments.session).toBe("work"));
  await openSectionMenu();
  await user.click(screen.getByRole("menuitem", { name: "Sessions" }));
  await waitFor(() => expect(h.saved().assignments.session).toBeUndefined());
  store.dispose();
});
