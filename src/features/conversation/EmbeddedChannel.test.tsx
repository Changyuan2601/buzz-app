// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { Context } from "@deepseek-ai/cordis";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddedChannel } from "./EmbeddedChannel";
import type { ChannelTimelineProps } from "../messages/ChannelTimeline";
import type { MessageComposerProps } from "../messages/MessageComposer";
import { useMessageDeletion } from "../messages/MessageManagement";
import type { ThreadPanelProps } from "../messages/ThreadPanel";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

// The real overlay owner, message management and window subscription are
// composed; the timeline, thread and composer have their own mounted suites.
let timeline: ChannelTimelineProps | undefined;
vi.mock("../messages/ChannelTimeline", () => ({
  ChannelTimeline: (props: ChannelTimelineProps) => {
    timeline = props;
    return (
      <section aria-label="Timeline">
        {props.window.rows.map((row) => (
          <p key={row.id}>{row.content}</p>
        ))}
      </section>
    );
  },
}));
vi.mock("../messages/ThreadPanel", () => ({
  ThreadPanel: ({ messageId }: ThreadPanelProps) => (
    <section aria-label="Thread" data-message={messageId} />
  ),
}));
vi.mock("../messages/MessageComposer", () => ({
  MessageComposer: ({ sessionConversation }: MessageComposerProps) => (
    <section
      aria-label="Composer"
      data-session-conversation={String(!!sessionConversation)}
      data-deletion={String(!!useMessageDeletion())}
    />
  ),
}));
afterEach(() => {
  cleanup();
  timeline = undefined;
});

const viewer = "a".repeat(64);
function message(id: string, extra: Partial<ChannelMessage> = {}) {
  return {
    id,
    channelId: "c",
    authorId: viewer,
    content: `message ${id.slice(0, 1)}`,
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    ...extra,
  } as ChannelMessage;
}
const top = message("1".repeat(64));
const reply = message("2".repeat(64), { threadRootId: top.id });

function fixture(channelType: "stream" | "session" = "stream") {
  let window: ChannelWindow = {
    channelId: "c",
    status: "loading",
    rows: [],
    hasMore: false,
    loadingOlder: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  // External-store snapshots keep their identity.
  const none: readonly never[] = [];
  const list = {
    channels: [{ id: "c", name: "Channel", channelType, members: [viewer] }],
  };
  const unread = {
    sync: () => ({ capability: "unsupported" }),
    snapshot: () => undefined,
    subscribe: () => () => {},
    attention: () => ({ unread: false }),
    enterChannel: vi.fn(async () => {}),
    leaveChannel: vi.fn(),
  };
  const session = {
    viewer,
    channels: {
      subscribeList: () => () => {},
      list: () => list,
      ensure: vi.fn(),
      refresh: vi.fn(),
      window: () => window,
      subscribeWindow: (_: string, fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    unread,
    outbox: {
      subscribe: () => () => {},
      observeSend: () => () => {},
      snapshot: () => none,
      supports: () => true,
      retry: vi.fn(),
    },
  } as unknown as RelaySession;
  const scope = `https://fixture.test:${viewer}`;
  let connection: { status: string; session?: RelaySession; scope?: string } = {
    status: "ready",
    session,
    scope,
  };
  const host = {
    panels: {
      snapshot: () => none,
      subscribe: () => () => {},
      resolve: () => undefined,
    },
    relay: { snapshot: () => connection },
    navigation: { open: vi.fn() },
  } as unknown as Context;
  return {
    props: {
      host,
      session,
      scope,
      channelId: "c",
      channelName: "Channel",
      extensions: {} as ComponentProps<typeof EmbeddedChannel>["extensions"],
    },
    session,
    unread,
    load(next: Partial<ChannelWindow>) {
      act(() => {
        window = { ...window, status: "ready", freshness: "verified", ...next };
        for (const fn of listeners) fn();
      });
    },
    disconnect() {
      connection = { status: "connecting" };
    },
  };
}

it("shows the channel at a loaded top-level message without touching Channels' saved place", () => {
  const h = fixture();
  render(<EmbeddedChannel {...h.props} messageId={top.id} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading messages…");
  h.load({ rows: [top, message("3".repeat(64))] });
  expect(screen.getByLabelText("Timeline")).toHaveTextContent("message 1");
  expect(screen.queryByLabelText("Thread")).not.toBeInTheDocument();
  expect(timeline?.inlineTarget?.messageId).toBe(top.id);
  expect(timeline?.inlineTarget?.signal.aborted).toBe(false);
  expect(timeline?.transient).toBe(true);
  // A later arrival does not switch the frozen choice.
  h.load({ rows: [message("3".repeat(64))] });
  expect(screen.getByLabelText("Timeline")).toBeInTheDocument();
});

it.each([
  ["outside the loaded window", [message("3".repeat(64))]],
  ["a reply", [top, reply]],
])("opens a message %s as its thread", (_, rows) => {
  const h = fixture();
  const id = rows.includes(reply) ? reply.id : top.id;
  render(<EmbeddedChannel {...h.props} messageId={id} />);
  h.load({ rows });
  expect(screen.getByLabelText("Thread")).toHaveAttribute("data-message", id);
  expect(screen.queryByLabelText("Timeline")).not.toBeInTheDocument();
});

it("shows the latest messages when no message is given", () => {
  const h = fixture();
  render(<EmbeddedChannel {...h.props} />);
  h.load({ rows: [top] });
  expect(screen.getByLabelText("Timeline")).toBeInTheDocument();
  expect(timeline?.inlineTarget).toBeUndefined();
});

it("offers threads only through the page, and not after the view is retired", () => {
  const h = fixture();
  const view = render(<EmbeddedChannel {...h.props} />);
  h.load({ rows: [top] });
  expect(timeline?.onOpenThread).toBeUndefined();
  const onOpenThread = vi.fn();
  view.rerender(<EmbeddedChannel {...h.props} onOpenThread={onOpenThread} />);
  timeline?.onOpenThread?.(reply.id, top.id);
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(reply.id, top.id);
  const stale = timeline?.onOpenThread;
  h.disconnect();
  stale?.(reply.id, top.id);
  view.unmount();
  stale?.(reply.id, top.id);
  expect(onOpenThread).toHaveBeenCalledOnce();
});

it("offers a retry when the channel cannot load", () => {
  const h = fixture();
  render(<EmbeddedChannel {...h.props} />);
  h.load({ status: "error", error: "Relay unavailable." });
  expect(screen.getByRole("alert")).toHaveTextContent("Relay unavailable.");
  fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
  expect(h.session.channels.refresh).toHaveBeenCalledExactlyOnceWith("c");
});

it.each([
  ["stream", "false"],
  ["session", "true"],
] as const)(
  "the %s-channel composer gets message management and session recipients=%s",
  (channelType, sessionConversation) => {
    const h = fixture(channelType);
    render(<EmbeddedChannel {...h.props} />);
    const composer = screen.getByLabelText("Composer");
    expect(composer).toHaveAttribute("data-deletion", "true");
    expect(composer).toHaveAttribute(
      "data-session-conversation",
      sessionConversation,
    );
    expect(h.unread.enterChannel).toHaveBeenCalledExactlyOnceWith("c");
  },
);
