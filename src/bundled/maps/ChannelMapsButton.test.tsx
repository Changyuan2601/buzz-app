// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ChannelMapsButton } from "./ChannelMapsButton";
afterEach(cleanup);
function fixture() {
  const viewer = "a".repeat(64);
  let channel: ChannelSummary = {
    id: "general",
    name: "general",
    members: [viewer],
  };
  const open = vi.fn();
  const session = {
    viewer,
    scope: `https://community.example:${viewer}`,
    channels: { list: () => ({ channels: [channel] }) },
  } as unknown as RelaySession;
  render(
    <ChannelMapsButton channel={channel} session={session} toggle={open} />,
  );
  return {
    viewer,
    open,
    revoke: () => {
      channel = { ...channel, members: [] };
    },
  };
}
it("toggles the map inside the current channel without navigating", () => {
  const f = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Open channel map" }));
  expect(f.open).toHaveBeenCalledExactlyOnceWith();
});
it("rechecks channel access before navigating", () => {
  const f = fixture();
  f.revoke();
  fireEvent.click(screen.getByRole("button", { name: "Open channel map" }));
  expect(f.open).not.toHaveBeenCalled();
});
