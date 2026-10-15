// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  TypingPresentation,
  useTypingReplacement,
} from "../conversation/typing-presentation";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { TypingIndicator } from "./TypingIndicator";

afterEach(cleanup);
const agent = "a".repeat(64);
const root = "d".repeat(64);
const library = { identities: [{ pubkey: agent }] };
const profiles = new Map([[agent, { name: "Agent" }]]);
const noRows: readonly never[] = [];
function fixture() {
  const listeners = new Set<() => void>();
  let typing: readonly TypingEntry[] = [];
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const session = {
    typing: { snapshot: () => typing, subscribe },
    agentChoices: { snapshot: () => library, subscribe },
    profiles: { snapshot: () => profiles, subscribe },
    channels: {
      window: () => ({ rows: noRows }),
      subscribeWindow: (_id: string, fn: () => void) => subscribe(fn),
    },
  } as unknown as RelaySession;
  return {
    session,
    listeners,
    update(entries: readonly TypingEntry[]) {
      act(() => {
        typing = entries;
        for (const listener of listeners) listener();
      });
    },
  };
}
// The composer's TypingIndicator beside the history is the lane's publisher.
function Composer({
  session,
  threadRootId,
  replaced = false,
}: {
  session: RelaySession;
  threadRootId?: string | undefined;
  replaced?: boolean;
}) {
  return (
    <TypingPresentation active>
      <TypingIndicator
        session={session}
        channelId="channel"
        threadRootId={threadRootId}
      />
      {replaced && (
        <Replacement session={session} threadRootId={threadRootId} />
      )}
    </TypingPresentation>
  );
}
function Replacement({
  session,
  threadRootId,
}: {
  session: RelaySession;
  threadRootId: string | undefined;
}) {
  useTypingReplacement(
    { session, channelId: "channel", threadRootId, pubkey: agent },
    true,
  );
  return null;
}
const lane = () =>
  screen
    .getByRole("button", { name: "Jump to latest" })
    .closest("[data-visible]");
const pill = () => screen.queryByRole("button", { name: /^Activity:/ });
const props = { visible: true, newMessageCount: 0, onClick() {} };

it("reserves the lane while the composer shows working agents and releases it after", () => {
  const f = fixture();
  render(
    <>
      <JumpToLatestButton
        {...props}
        activityLane={{ session: f.session, channelId: "channel" }}
      />
      <Composer session={f.session} />
    </>,
  );
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  f.update([{ pubkey: agent, channelId: "channel", threadRootId: root }]);
  expect(pill()).toBeInTheDocument();
  expect(lane()).toHaveAttribute("data-activity-lane");
  f.update([]);
  expect(pill()).toBeNull();
  expect(lane()).not.toHaveAttribute("data-activity-lane");
});

it("does not reserve the lane for an agent whose activity an accessory replaced", () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel", threadRootId: root }]);
  const view = render(
    <>
      <JumpToLatestButton
        {...props}
        activityLane={{ session: f.session, channelId: "channel" }}
      />
      <Composer session={f.session} replaced />
    </>,
  );
  expect(pill()).toBeNull();
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  view.rerender(
    <>
      <JumpToLatestButton
        {...props}
        activityLane={{ session: f.session, channelId: "channel" }}
      />
      <Composer session={f.session} />
    </>,
  );
  expect(pill()).toBeInTheDocument();
  expect(lane()).toHaveAttribute("data-activity-lane");
});

it("scopes a thread lane to that thread's composer", () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel", threadRootId: root }]);
  render(
    <>
      <JumpToLatestButton
        {...props}
        activityLane={{
          session: f.session,
          channelId: "channel",
          threadRootId: root,
        }}
      />
      <Composer session={f.session} />
    </>,
  );
  // The channel composer shows the agent; the thread's lane stays free.
  expect(pill()).toBeInTheDocument();
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  render(<Composer session={f.session} threadRootId={root} />);
  expect(lane()).toHaveAttribute("data-activity-lane");
});

it("keeps the focused button mounted across a lane gate flip and never subscribes to typing", () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel", threadRootId: root }]);
  render(<Composer session={f.session} />);
  const typingListeners = f.listeners.size;
  const view = render(<JumpToLatestButton {...props} />);
  const button = screen.getByRole("button", { name: "Jump to latest" });
  button.focus();
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  view.rerender(
    <JumpToLatestButton
      {...props}
      activityLane={{ session: f.session, channelId: "channel" }}
    />,
  );
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(lane()).toHaveAttribute("data-activity-lane");
  view.rerender(<JumpToLatestButton {...props} />);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  expect(f.listeners.size).toBe(typingListeners);
});
