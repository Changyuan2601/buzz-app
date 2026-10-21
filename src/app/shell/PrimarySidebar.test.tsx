// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { writeView } from "../../shared/view-state";
import { soloDraftTarget } from "../../features/channel-navigation/routes";

import { fixture, owners, id, scope } from "./sidebar-testing";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";
import { SOLO_LABEL } from "../../features/solo/labels";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

it("double-clicks a Solo row to edit its selected name, retaining a failed save for retry", async () => {
  const user = userEvent.setup();
  const f = fixture();
  const base: ChannelDetails = {
    channelId: id,
    name: "Planning",
    description: "",
    visibility: "private",
    labels: [SOLO_LABEL],
    version: "original",
    canEdit: true,
  };
  const save = vi.fn(async () => {});
  save.mockRejectedValueOnce(new Error("Couldn’t save the name. Try again."));
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(async () => base),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  const row = screen.getByRole("button", { name: /^Planning/ });
  await user.click(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  f.open.mockClear();
  await user.dblClick(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  const name = await screen.findByRole("textbox", { name: "Chat name" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(name).toHaveFocus());
  expect(name).toHaveValue("Planning");
  expect((name as HTMLInputElement).selectionStart).toBe(0);
  expect((name as HTMLInputElement).selectionEnd).toBe(8);
  await user.keyboard("New plan");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t save the name",
  );
  expect(name).toHaveValue("New plan");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenLastCalledWith(
    base,
    expect.objectContaining({ name: "New plan", labels: [SOLO_LABEL] }),
    expect.any(AbortSignal),
  );
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await screen.findByRole("textbox", { name: "Chat name" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenCalledTimes(2);
});

it("does not open renaming when Solo details are unavailable", async () => {
  const user = userEvent.setup();
  const f = fixture();
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

function delayedRename() {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const save: ChannelDetailsCapability["save"] = vi.fn(
    async (_base, _draft, active) => {
      signal = active;
      await gate;
    },
  );
  const f = fixture();
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(
        async (channelId: string): Promise<ChannelDetails> => ({
          channelId,
          name: channelId === id ? "Planning" : "Other",
          description: "",
          visibility: "private",
          labels: [SOLO_LABEL],
          version: "one",
          canEdit: true,
        }),
      ),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  return {
    user: userEvent.setup(),
    save,
    signal: () => signal,
    finish: async () => {
      await act(async () => {
        finish();
        await gate;
      });
    },
  };
}

it("keeps a click-away save alive when another row is double-clicked", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  const input = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(input).toHaveFocus());
  await f.user.keyboard("First renamed");
  try {
    await f.user.dblClick(screen.getByRole("button", { name: /^Other/ }));
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    expect(input).toHaveValue("First renamed");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(f.signal()?.aborted).toBe(false);
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  const destination = screen.getByRole("button", { name: /^Other/ });
  expect(destination).toHaveFocus();
  await f.user.dblClick(destination);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
      "Other",
    ),
  );
  await f.user.keyboard("{Escape}");
});

it("keeps focus on a different chat after an Enter-save finishes", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveFocus(),
  );
  await f.user.keyboard("First renamed{Enter}");
  const destination = screen.getByRole("button", { name: /^Other/ });
  try {
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    await f.user.click(destination);
    expect(destination).toHaveFocus();
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(destination).toHaveFocus();
});
it("ignores saved Solo/Team filters and keeps all conversations in one inventory", async () => {
  writeView(scope, "navigation-scope", { filter: "team" });
  const f = fixture(true, true);
  await screen.findByRole("button", { name: /^Planning/ });
  expect(screen.queryByRole("tab", { name: "Team" })).toBeNull();
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(
    screen.getAllByRole("separator", { name: "Resize sidebar" }),
  ).toHaveLength(1);
  expect(f.open).not.toHaveBeenCalled();
});

it("keeps unavailable creation actions disabled", () => {
  fixture(true);
  for (const button of screen.getAllByRole("button", { name: "New chat" }))
    expect(button).toBeDisabled();
});

it("filters private chats from the Messages header without navigating", async () => {
  const user = userEvent.setup();
  const f = fixture(true);
  expect(
    await screen.findByRole("button", { name: /^Planning/ }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Filter messages" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Public chats" }),
  );
  expect(screen.queryByRole("button", { name: /^Planning/ })).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Private chats" }),
  );
  expect(
    await screen.findByRole("button", { name: /^Planning/ }),
  ).toBeVisible();
  await user.click(
    await screen.findByRole("menuitemradio", { name: "All time" }),
  );
  expect(
    await screen.findByRole("menuitemradio", { name: "All time" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(
    screen.getByRole("menuitemradio", { name: "Private chats" }),
  ).toHaveAttribute("aria-checked", "true");
});
