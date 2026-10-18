// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { writeView } from "../../shared/view-state";
import { conversationTarget, soloDraftTarget } from "./routes";

import {
  fixture,
  owners,
  id,
  other,
  agent,
  outsider,
  root,
  scope,
} from "../../app/shell/sidebar-testing";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
it("keeps unread state while owned thread typing and observer working signals start and stop", () => {
  const f = fixture();
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
it("opens a typing-only agent's profile activity in its Solo chat", async () => {
  const f = fixture();
  f.typing([{ channelId: id, pubkey: agent }]);
  const user = userEvent.setup();
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  let popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", { name: "View Owned Agent activity" }),
  );
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", {
      name: "Open conversation for Owned Agent in Planning",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
});
it.each([
  { observedCount: 1, attentionCount: 1 },
  { observedCount: 1, attentionCount: 0 },
])(
  "bolds a Solo chat for any unread message, keeping its dot for attention only ($observedCount unread, $attentionCount attention)",
  (counts) => {
    const f = fixture(false, false, undefined, counts);
    const row = screen.getByRole("button", { name: /^Planning/ });
    expect(
      row.querySelector('[data-channel-unread-title="true"]'),
    ).toBeInTheDocument();
    expect(!!row.querySelector("[data-channel-priority]")).toBe(
      counts.attentionCount > 0,
    );
    f.clearUnread();
    expect(row.querySelector('[data-channel-unread-title="true"]')).toBeNull();
  },
);

it.each(["new", "linked", "agent"])(
  "shows and selects the ordinary New chat draft row for %s",
  async (route) => {
    const f = fixture();
    writeView(scope, "solo:collapsed-projects", [""]);
    const target = soloDraftTarget(
      scope,
      route === "agent"
        ? { agent }
        : route === "linked"
          ? { linked: "33333333-3333-4333-8333-333333333333" }
          : {},
    );
    act(() => f.navigate(target));
    const draft = await screen.findByRole("button", { name: "New chat" });
    expect(draft).toHaveAttribute("aria-current", "page");
    expect(draft).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: /^Other/ })).not.toHaveAttribute(
      "aria-current",
    );
    await userEvent.click(draft);
    expect(f.open).toHaveBeenLastCalledWith(target);
    act(() => f.navigate(conversationTarget(scope, id)));
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Planning/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  },
);
