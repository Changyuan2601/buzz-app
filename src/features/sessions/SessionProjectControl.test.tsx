// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { SessionProjectControl } from "./SessionProjectControl";

afterEach(cleanup);

function fixture() {
  const assign = vi.fn(async () => {});
  const snapshot = {
    status: "ready" as const,
    data: {
      sections: [{ id: "buzz", name: "Buzz App", order: 0 }],
      assignments: { chat: "buzz" },
      starred: [],
      muted: [],
    },
  };
  const session = {
    mePreferences: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      assign,
      refresh: vi.fn(async () => {}),
    },
  } as unknown as RelaySession;
  return { session, assign };
}

it("moves a saved chat without changing project defaults", async () => {
  const { session, assign } = fixture();
  const user = userEvent.setup();
  render(<SessionProjectControl session={session} channelId="chat" />);
  await user.click(screen.getByRole("button", { name: "Project: Buzz App" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "No project" }),
  );
  expect(assign).toHaveBeenCalledWith("chat", undefined);
});

it("changes a new-chat project locally instead of moving a saved channel", async () => {
  const { session, assign } = fixture();
  const change = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionProjectControl session={session} value="" onChange={change} />,
  );
  await user.click(screen.getByRole("button", { name: "Add project" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Buzz App" }),
  );
  expect(change).toHaveBeenCalledWith("buzz");
  expect(assign).not.toHaveBeenCalled();
});

it("keeps project recovery reachable after preferences fail", async () => {
  const refresh = vi.fn(async () => {});
  const session = {
    mePreferences: {
      snapshot: () => ({ status: "error", error: "Projects unavailable" }),
      subscribe: () => () => {},
      assign: vi.fn(async () => {}),
      refresh,
    },
  } as unknown as RelaySession;
  const user = userEvent.setup();
  render(<SessionProjectControl session={session} channelId="chat" />);
  await user.click(screen.getByRole("button", { name: "Add project" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Retry projects" }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});
