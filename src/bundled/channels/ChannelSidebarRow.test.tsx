// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChannelSidebarRow } from "./ChannelSidebarRow";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("offers a separate hide action only for DM rows", async () => {
  const onHideDm = vi.fn();
  const onSelect = vi.fn();
  render(
    <ChannelSidebarRow
      channel={{
        id: "dm",
        name: "Alice",
        channelType: "dm",
        lastActivityAt: Date.now() / 1000,
      }}
      icon={<svg />}
      onSelect={onSelect}
      onPrepare={() => {}}
      onHideDm={onHideDm}
    />,
  );
  expect(screen.getByText("now")).toBeInTheDocument();
  const remove = screen.getByRole("button", {
    name: "Remove Alice from DMs",
  });
  expect(remove).not.toHaveAttribute("title");
  await userEvent.setup().click(remove);
  expect(onHideDm).toHaveBeenCalledWith("dm");
  expect(onSelect).not.toHaveBeenCalled();
});
it("keeps focus in the sidebar when removing its last visible DM", async () => {
  function OnlyDm() {
    const [visible, setVisible] = useState(true);
    return (
      <div>
        <div data-sidebar-section="">
          <details open>
            <summary>Channels</summary>
          </details>
        </div>
        {visible && (
          <div data-sidebar-section="">
            <details open>
              <summary>DMs</summary>
            </details>
            <ChannelSidebarRow
              channel={{ id: "dm", name: "Alice", channelType: "dm" }}
              icon={<svg />}
              onSelect={() => {}}
              onPrepare={() => {}}
              onHideDm={() => setVisible(false)}
            />
          </div>
        )}
      </div>
    );
  }
  render(<OnlyDm />);
  const remove = screen.getByRole("button", { name: "Remove Alice from DMs" });
  remove.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(screen.queryByText("DMs")).not.toBeInTheDocument();
  expect(screen.getByText("Channels")).toHaveFocus();
});

it("shows and refreshes compact ages beside unread indicators", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T19:20:00Z"));
  const timestamp = Date.now() / 1000;
  const row = (id: string, channelType: "stream" | "dm") => (
    <ChannelSidebarRow
      channel={{ id, name: id, channelType, lastActivityAt: timestamp }}
      icon={<svg />}
      badge={<span>Unread</span>}
      onSelect={() => {}}
      onPrepare={() => {}}
    />
  );
  render(
    <>
      {row("team", "stream")}
      {row("direct", "dm")}
      <ChannelSidebarRow
        channel={{ id: "quiet", name: "quiet", channelType: "stream" }}
        icon={<svg />}
        onSelect={() => {}}
        onPrepare={() => {}}
      />
    </>,
  );

  expect(screen.getAllByText("now")).toHaveLength(2);
  expect(screen.getAllByText("Unread")).toHaveLength(2);
  const firstUnread = screen.getAllByText("Unread")[0];
  const firstAge = screen.getAllByText("now")[0];
  if (!firstUnread || !firstAge) throw new Error("Expected activity labels");
  expect(
    firstUnread.compareDocumentPosition(firstAge) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  const quietButton = screen.getByText("quiet").closest("button");
  expect(quietButton?.querySelector("time")).toBeNull();

  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getAllByText("1m")).toHaveLength(2);
  expect(screen.getAllByText("1 minute ago")).toHaveLength(2);
});
