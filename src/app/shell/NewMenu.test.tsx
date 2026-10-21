// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { fixture, owners } from "./sidebar-testing";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { writeView } from "../../shared/view-state";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
it("opens the recipient-first draft regardless of an old saved variant", async () => {
  writeView("shell:chat-creation", "variant", "dialog");
  const f = fixture(true, true);
  const user = userEvent.setup();
  // CSS swaps the compact and expanded controls; both have the same action.
  for (const trigger of screen.getAllByRole("button", { name: "New chat" })) {
    await user.click(trigger);
    expect(f.open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        route: { version: 1, params: "new-chat-recipient" },
      }),
    );
  }
  expect(
    screen.queryByRole("button", { name: "Chat creation variant" }),
  ).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
