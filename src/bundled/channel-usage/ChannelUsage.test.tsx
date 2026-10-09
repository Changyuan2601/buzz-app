// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { ArchiveHost, ArchivePage } from "../../features/archive/types";
import { ChannelUsage } from "./ChannelUsage";

const key = (n: number) => n.toString(16).padStart(64, "0");
const frame = (
  agent: number,
  session: string,
  turn: number,
  total?: number,
): ArchivePage["records"][number] => ({
  id: key(agent * 100 + turn + (session === "b" ? 50 : 0)),
  agent: key(agent),
  createdAt: turn,
  receivedAt: turn,
  plaintext: JSON.stringify({
    harness: "goose",
    model: "model",
    timestamp: new Date((turn + 1) * 1000).toISOString(),
    channelId: "channel",
    sessionId: session,
    turnId: `turn-${turn}`,
    turnSeq: turn,
    turn: { inputTokens: 0, costUsd: 0 },
    cumulative: { inputTokens: 10, totalTokens: total ?? null, costUsd: 0 },
  }),
});
const host = (records: ArchivePage["records"]): ArchiveHost => ({
  location: "device",
  settings: vi.fn(async () => ({
    observer: true,
    metrics: true,
    observerDays: 30,
    revision: 1,
    location: "device" as const,
    path: "isolated",
    bytes: 0,
  })),
  read: vi.fn(async () => ({
    records,
    before: null,
    agents: [],
    skipped: 0,
    revision: 1,
  })),
  configure: vi.fn(),
  clear: vi.fn(),
});
function fixture(records: ArchivePage["records"]) {
  const archive = host(records);
  let access = true;
  const listeners = new Set<() => void>();
  const list = {
    status: "ready",
    channels: [{ id: "channel", name: "Channel", members: [key(9)] }],
  };
  const empty = { status: "ready", channels: [] };
  const session = {
    viewer: key(9),
    agentActivity: { archive },
    channels: {
      list: () => (access ? list : empty),
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    archive,
    revoke: () =>
      act(() => {
        access = false;
        for (const listener of listeners) listener();
      }),
  };
}
afterEach(cleanup);
it("opens the selected agent, requires explicit multi-session selection, and expands zero-valued turn details", async () => {
  const records = [
    frame(1, "a", 1, 0),
    frame(1, "b", 2, 20),
    frame(2, "a", 1, 30),
  ];
  const { session } = fixture(records);
  render(<ChannelUsage session={session} channelId="channel" />);
  const user = userEvent.setup();
  const picker = screen.getByRole("combobox", { name: "Agent usage" });
  expect(picker.textContent).toContain("Select agent");
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: /2 sessions/ }));
  expect(picker.textContent).toContain("2 sessions");
  const totals = screen.getByRole("region", { name: "All session totals" });
  expect(within(totals).getByText("Totals across 2 sessions")).toBeTruthy();
  expect(within(totals).getAllByText("20")).toHaveLength(2);
  // Both latest snapshots report input; token totals and costs use different coverage.
  expect(within(totals).getByText("$0.00")).toBeTruthy();
  expect(screen.queryByText("Latest reported session counters")).toBeNull();
  const sessions = screen.getByRole("combobox", { name: "Session" });
  expect(sessions.textContent).toContain("Select session");
  await user.click(sessions);
  await user.click(await screen.findByRole("option", { name: /Session 1 ·/ }));
  expect(screen.getByText("Latest reported session counters")).toBeTruthy();
  const list = screen.getByRole("region", { name: /recorded turns/ });
  await user.click(within(list).getByRole("button", { name: /Show turn/ }));
  expect(within(list).getByText("Input")).toBeTruthy();
  expect(within(list).getAllByText("$0.00").length).toBeGreaterThan(0);
  await user.click(sessions);
  await user.click(await screen.findByRole("option", { name: /Session 2 ·/ }));
  expect(
    within(screen.getByRole("region", { name: /recorded turns/ })).queryByText(
      "Input",
    ),
  ).toBeNull();
  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(picker);
  expect(
    screen.queryByRole("region", { name: "Session usage details" }),
  ).toBeNull();
});
it("hides decoded usage when the authorized channel disappears", async () => {
  const { session, revoke } = fixture([frame(1, "a", 1, 10)]);
  render(<ChannelUsage session={session} channelId="channel" />);
  expect(
    await screen.findByRole("combobox", { name: "Agent usage" }),
  ).toBeTruthy();
  revoke();
  expect(screen.queryByRole("combobox", { name: "Agent usage" })).toBeNull();
  expect(screen.queryByText("Channel session usage")).toBeNull();
});
it("keeps incomplete cross-session counters unknown and handles a hundred sessions in one dropdown", async () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    ...frame(1, `session-${index}`, index + 1, index + 1),
    id: key(index + 1000),
    ...(index === 0
      ? {
          plaintext: JSON.stringify({
            harness: "goose",
            timestamp: new Date(2000).toISOString(),
            channelId: "channel",
            turnSeq: 1,
            turn: { inputTokens: 1 },
          }),
        }
      : {}),
  }));
  // One unidentified session has no trustworthy cumulative snapshot.
  const { session } = fixture(records);
  render(<ChannelUsage session={session} channelId="channel" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Agent usage" }));
  await user.click(await screen.findByRole("option", { name: /100 sessions/ }));
  const totals = screen.getByRole("region", { name: "All session totals" });
  expect(within(totals).getByText(/99 of 100 sessions/)).toBeTruthy();
  expect(within(totals).getAllByText("—").length).toBe(6);
  const picker = screen.getByRole("combobox", { name: "Session" });
  await user.click(picker);
  expect(await screen.findAllByRole("option")).toHaveLength(100);
  await user.click(screen.getByRole("option", { name: /Session 99 ·/ }));
  expect(screen.getByText("Latest reported session counters")).toBeTruthy();
});
