// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";

const viewport = vi.hoisted(() => ({ size: 0 }));
// Control the independent virtualizer's public measurement/shift contract.
// React itself owns the real timeline's refs, render and effect ordering.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        shift,
      }: { children: import("react").ReactNode; shift: boolean },
      ref,
    ) {
      useImperativeHandle(
        ref,
        () => ({
          get viewportSize() {
            return viewport.size;
          },
          cache: [[], 40],
          scrollTo: vi.fn(),
          scrollToIndex: vi.fn(),
        }),
        [],
      );
      return (
        <ol aria-label="Virtualized messages" data-shift={shift}>
          {children}
        </ol>
      );
    }),
  };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row }: { row: ChannelMessage }) => <li>{row.content}</li>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("keeps membership notices visible in personal chats", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const row: ChannelMessage = {
    id: "joined",
    channelId: "alpha",
    authorId: viewer.pubkey,
    content: "",
    createdAt: 1,
    membership: {
      type: "member_joined",
      actor: viewer.pubkey,
      target: viewer.pubkey,
    },
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const window: ChannelWindow = {
    channelId: "alpha",
    rows: [row],
    status: "ready",
    hasMore: false,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
  };
  try {
    const view = render(
      <ChannelTimeline
        channelId="alpha"
        scope="membership"
        viewer={viewer.pubkey}
        queries={owner.session}
        window={window}
        chatPresentation
        onOpenLink={() => false}
      />,
    );
    expect(screen.getByText("You joined")).toBeVisible();
    view.rerender(
      <ChannelTimeline
        channelId="alpha"
        scope="membership"
        viewer={viewer.pubkey}
        queries={owner.session}
        window={{
          ...window,
          rows: [
            {
              ...row,
              id: "left",
              membership: {
                type: "member_left",
                actor: viewer.pubkey,
                target: viewer.pubkey,
              },
            },
          ],
        }}
        chatPresentation
        onOpenLink={() => false}
      />,
    );
    expect(screen.getByText("You left the channel")).toBeVisible();
    view.unmount();
  } finally {
    owner.dispose();
  }
});

it.each([0, 600])(
  "prepend compensation requires a measured virtualizer viewport (%s)",
  (size) => {
    viewport.size = size;
    // The outer timeline can have layout before Virtua's own observer delivers.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Leave positioning frames queued: this case controls the premeasurement boundary.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const viewer = keypair(),
      relay = keypair();
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    });
    const older = message(viewer, "alpha", "Older finite message", 1);
    const live = message(viewer, "alpha", "Live message", 2);
    const snapshot = (
      events: Parameters<typeof foldMessages>[2],
    ): ChannelWindow => ({
      channelId: "alpha",
      rows: foldMessages("alpha", relay.pubkey, events),
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      freshness: "verified",
      error: undefined,
    });
    const content = (window: ChannelWindow) => (
      <ChannelTimeline
        channelId="alpha"
        scope="viewport-regression"
        queries={owner.session}
        window={window}
        onOpenLink={() => false}
      />
    );
    try {
      const view = render(content(snapshot([live])));
      const boundary = screen.getByRole("list", {
        name: "Virtualized messages",
      });
      expect(boundary).toHaveAttribute("data-shift", "false");
      expect(screen.getByText("Live message")).toBeVisible();
      view.rerender(content(snapshot([older, live])));
      expect(screen.getByRole("list", { name: "Virtualized messages" })).toBe(
        boundary,
      );
      expect(boundary).toHaveAttribute("data-shift", size ? "true" : "false");
      expect(screen.getByText("Older finite message")).toBeVisible();
      view.unmount();
    } finally {
      owner.dispose();
    }
  },
);

it("keeps host actions after their exact message as later messages arrive, and never moves them to the tail when the anchor is absent", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const viewer = keypair(),
    relay = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const greeting = message(
    relay,
    "alpha",
    "I’m Mochi. You can start chatting.",
    1,
  );
  const request = message(viewer, "alpha", "Tell me about Buzz", 2);
  const reply = message(
    relay,
    "alpha",
    "Buzz is a place to work with agents.",
    3,
  );
  const content = (events: (typeof greeting)[]) => (
    <ChannelTimeline
      channelId="alpha"
      scope="actions"
      queries={owner.session}
      window={{
        channelId: "alpha",
        rows: foldMessages("alpha", relay.pubkey, events),
        status: "ready",
        hasMore: false,
        loadingOlder: false,
        freshness: "verified",
        error: undefined,
      }}
      afterMessages={
        <section aria-label="Get started">
          <button type="button">Tell me about Buzz</button>
        </section>
      }
      afterMessageId={greeting.id}
      onOpenLink={() => false}
    />
  );
  try {
    const view = render(content([greeting]));
    const card = screen.getByRole("region", { name: "Get started" });
    const order = () =>
      [...screen.getByRole("list", { name: "Virtualized messages" }).children]
        .map((row) => row.textContent)
        .filter(Boolean);
    expect(order()).toEqual([greeting.content, "Tell me about Buzz"]);
    view.rerender(content([greeting, request]));
    expect(order()).toEqual([
      greeting.content,
      "Tell me about Buzz",
      request.content,
    ]);
    view.rerender(content([greeting, request, reply]));
    expect(order()).toEqual([
      greeting.content,
      "Tell me about Buzz",
      request.content,
      reply.content,
    ]);
    expect(screen.getAllByRole("region", { name: "Get started" })).toEqual([
      card,
    ]);
    expect(within(card).getByRole("button")).toBeEnabled();
    view.rerender(content([request, reply]));
    expect(screen.queryByRole("region", { name: "Get started" })).toBeNull();
    view.rerender(content([greeting, request, reply]));
    expect(screen.getAllByRole("region", { name: "Get started" })).toHaveLength(
      1,
    );
    expect(order()).toEqual([
      greeting.content,
      "Tell me about Buzz",
      request.content,
      reply.content,
    ]);
    view.unmount();
  } finally {
    owner.dispose();
  }
});
