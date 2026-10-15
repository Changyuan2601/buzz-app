// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { apply, MapChannel } from "./index";
import { INITIAL_MAP, WINTERMUTE, mapPrompt, mapRequest } from "./model";
import { retailerResource } from "./retailer-reference";
const observed = vi.hoisted(() => ({
  map: null,
  composer: null,
  timeline: null,
  thread: null,
  members: null,
}));
vi.mock("./MapView", () => ({
  MapView: (props) => {
    observed.map = props;
    return createElement("section", { "aria-label": "Interactive map" });
  },
}));
vi.mock("../../features/messages/ChannelTimeline", () => ({
  ChannelTimeline: (props) => {
    observed.timeline = props;
    return createElement(
      "div",
      null,
      props.window.rows.map((row) =>
        createElement("p", { key: row.id }, row.content),
      ),
    );
  },
}));
vi.mock("../../features/messages/ThreadPanel", () => ({
  ThreadPanel: (props) => {
    observed.thread = props;
    return createElement(
      "section",
      { "aria-label": "Thread" },
      createElement(
        "button",
        { type: "button", onClick: props.close },
        "Close thread",
      ),
    );
  },
}));
vi.mock("../../features/messages/MessageManagement", () => ({
  MessageManagement: ({ children }) => children,
  MessageManagementStatus: () => null,
}));
vi.mock("../channels/ChannelMembersDialog", () => ({
  ChannelMembersButton: (props) => {
    observed.members = props;
    return createElement("button", { type: "button" }, "Channel members");
  },
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function source(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    snapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}
async function fixture({
  name = "map",
  route,
  closeMap,
  initialWindow = { rows: [], status: "ready" },
  agents = [{ pubkey: WINTERMUTE, name: "Wintermute" }],
} = {}) {
  const viewer = "f".repeat(64),
    other = "e".repeat(64);
  const directory = source({
    channels: [
      {
        id: "map-channel",
        name,
        channelType: "stream",
        members: [viewer, WINTERMUTE, other],
      },
    ],
  });
  const window = source(initialWindow),
    outbox = [];
  const thread = source({ replies: [] });
  const dispose = vi.fn();
  const choices = source({
    selectable: agents,
    pending: false,
    archives: { status: "ready" },
  });
  const session = {
    viewer,
    scope: `https://community.example:${viewer}`,
    agentChoices: { ...choices, retain: () => () => {}, ensure: vi.fn() },
    channels: {
      list: directory.snapshot,
      subscribeList: directory.subscribe,
      window: window.snapshot,
      subscribeWindow: (_id, listener) => window.subscribe(listener),
      ensure: vi.fn(),
    },
    outbox: { snapshot: () => outbox },
    thread: vi.fn(() => ({ ...thread, refresh: vi.fn(), dispose })),
  };
  const connection = source({
    status: "ready",
    scope: session.scope,
    generation: 1,
    session,
  });
  let Page;
  const control = { start: vi.fn() };
  let LocationTool;
  const insertResource = vi.fn(() => true),
    focus = vi.fn();
  const Composer = (props) => {
    observed.composer = props;
    return createElement(
      "div",
      { "data-testid": "shared-composer" },
      LocationTool &&
        createElement(LocationTool, {
          ...props,
          insertResource,
          focus,
          disabled: !!props.disabled,
        }),
    );
  };
  const ctx = {
    effect: () => {},
    agentControl: control,
    relay: connection,
    pages: {
      register: ({ component }) => {
        Page = component;
      },
    },
    conversation: {
      ui: { Composer },
      registerTool: ({ component }) => {
        LocationTool = component;
      },
      registerLink: vi.fn(),
    },
    navigation: { open: vi.fn() },
  };
  apply(ctx);
  await act(async () => {
    render(
      closeMap
        ? createElement(MapChannel, {
            ctx,
            session,
            channelId: "map-channel",
            closeMap,
            active: () => true,
          })
        : createElement(
            Page,
            route
              ? {
                  navigation: {
                    target: {
                      kind: "page",
                      route: { version: 1, params: route },
                    },
                  },
                }
              : {},
          ),
    );
  });
  const prepare = (text, recipients = []) =>
    observed.composer.prepareSend({ content: text, recipients });
  const publish = (prepared, notify = true, delivery = "accepted") => {
    prepared.beforePublish();
    const id = crypto.randomUUID();
    outbox.push({
      event: {
        id,
        content: prepared.content,
        tags: [[notify ? "p" : "mention", prepared.recipients.at(-1).pubkey]],
      },
    });
    act(() => {
      prepared.onPublished(id);
      window.set({
        rows: [
          ...window.snapshot().rows,
          {
            id,
            content: prepared.content,
            channelId: "map-channel",
            authorId: viewer,
            delivery,
          },
        ],
      });
    });
    return { root: id, request: mapRequest(prepared.content).request };
  };
  const reply = (request, map) => ({
    id: crypto.randomUUID(),
    authorId: WINTERMUTE,
    signerId: WINTERMUTE,
    channelId: "map-channel",
    content: JSON.stringify({
      requestId: request,
      message: "Map updated.",
      map,
    }),
  });
  return {
    viewer,
    other,
    directory,
    window,
    thread,
    dispose,
    prepare,
    publish,
    reply,
    session,
    control,
    navigation: ctx.navigation,
    insertResource,
    focus,
  };
}
it("restores plotted markers when reopening a channel after verified history loads", async () => {
  const request = "12345678-1234-1234-1234-123456789abc";
  const map = {
    ...INITIAL_MAP,
    markers: [{ coordinates: [-122.4194, 37.7749], label: "San Francisco" }],
  };
  const rows = [
    {
      id: "question",
      authorId: "f".repeat(64),
      channelId: "map-channel",
      mentions: [WINTERMUTE],
      content: mapPrompt(request, "Show cities", INITIAL_MAP),
    },
    {
      id: "answer",
      authorId: WINTERMUTE,
      signerId: WINTERMUTE,
      channelId: "map-channel",
      content: JSON.stringify({ requestId: request, message: "Cities", map }),
    },
  ];
  const f = await fixture({
    closeMap: vi.fn(),
    initialWindow: { rows, status: "ready", freshness: "cached" },
  });
  expect(observed.map.state.markers).toEqual([]);
  act(() => f.window.set({ rows, status: "ready", freshness: "verified" }));
  expect(observed.map.state.markers).toEqual(map.markers);
});
it("embeds the map in a channel and closes locally without changing navigation", async () => {
  const closeMap = vi.fn();
  const f = await fixture({ name: "general", closeMap });
  expect(observed.composer.channelId).toBe("map-channel");
  expect(
    screen.getByRole("button", { name: "Close channel map" }),
  ).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Close channel map" }));
  expect(closeMap).toHaveBeenCalledOnce();
  expect(f.navigation.open).not.toHaveBeenCalled();
});
it("routes an unselected text mention to the local channel Wintermute instead of the original identity", async () => {
  const local = "e".repeat(64);
  const f = await fixture({
    agents: [
      { pubkey: WINTERMUTE, name: "Wintermute", managed: false },
      { pubkey: local, name: "Wintermute", managed: true },
    ],
  });
  const prepared = f.prepare(`@${local.slice(0, 12)} plot the salons`);
  expect(prepared.recipients.at(-1).pubkey).toBe(local);
});
it("uses the shared composer and timeline on #map, preserving people and adding Wintermute", async () => {
  const f = await fixture();
  expect(screen.getByTestId("shared-composer")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Channel members" }),
  ).toBeInTheDocument();
  expect(observed.composer.session).toBe(f.session);
  expect(observed.members.control).toBe(f.control);
  expect(observed.composer.channelId).toBe("map-channel");
  const input = f.prepare("Show Paris", [
    { pubkey: f.other, name: "Other person" },
  ]);
  expect(input.recipients).toEqual([
    { pubkey: f.other, name: "Other person" },
    { pubkey: WINTERMUTE, name: "Wintermute" },
  ]);
  const pending = f.publish(input),
    next = { ...INITIAL_MAP, center: [2.35, 48.86] };
  act(() =>
    f.window.set({
      rows: [
        f.reply(pending.request, next),
        {
          id: "human",
          channelId: "map-channel",
          authorId: f.other,
          content: "I am joining.",
        },
      ],
    }),
  );
  expect(observed.map.state).toEqual(next);
  expect(screen.getByText("I am joining.")).toBeInTheDocument();
  expect(screen.getByText("Map updated.")).toBeInTheDocument();
  act(() => observed.map.onContext({ ...next, zoom: 14 }));
  expect(f.prepare("What is here?").content).toContain('"zoom":14');
});
it("addresses a mentioned local clone and only accepts that agent's map reply", async () => {
  const marco = { pubkey: "b".repeat(64), name: "MarcoPolo" };
  const f = await fixture({ agents: [marco] });
  const input = f.prepare("Show Paris", [marco]);
  expect(input.recipients).toEqual([marco]);
  const pending = f.publish(input);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for MarcoPolo");
  const next = { ...INITIAL_MAP, center: [2.35, 48.86] };
  const reply = f.reply(pending.request, next);
  act(() => f.window.set({ rows: [reply] }));
  expect(observed.map.state).toEqual(INITIAL_MAP);
  act(() =>
    f.window.set({
      rows: [{ ...reply, authorId: marco.pubkey, signerId: marco.pubkey }],
    }),
  );
  expect(observed.map.state).toEqual(next);
  expect(observed.composer.disabled).toBe(false);
});
it("rejects ambiguous map-agent mentions", async () => {
  const marco = { pubkey: "b".repeat(64), name: "MarcoPolo" };
  const winter = { pubkey: WINTERMUTE, name: "Wintermute" };
  const f = await fixture({ agents: [marco, winter] });
  expect(() => f.prepare("Show Paris", [marco, winter])).toThrow(
    "Mention one agent",
  );
});
it("rechecks background publication and ignores a late abandoned update", async () => {
  const f = await fixture();
  const first = f.prepare("First"),
    second = f.prepare("Second");
  const pending = f.publish(first);
  expect(() => second.beforePublish()).toThrow("Wait for Wintermute");
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  const newer = f.publish(f.prepare("New question"));
  act(() =>
    f.window.set({
      rows: [f.reply(pending.request, { ...INITIAL_MAP, center: [10, 20] })],
    }),
  );
  expect(observed.map.state).toEqual(INITIAL_MAP);
  expect(observed.composer.disabled).toBe(true);
  act(() => f.window.set({ rows: [f.reply(newer.request, INITIAL_MAP)] }));
  expect(observed.composer.disabled).toBe(false);
});
it("unmounts private map state and blocks deferred publication when channel access is lost", async () => {
  const f = await fixture();
  const input = f.prepare("Show Paris");
  act(() => f.directory.set({ channels: [] }));
  expect(
    screen.queryByRole("region", { name: "Interactive map" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId("shared-composer")).not.toBeInTheDocument();
  expect(() => input.beforePublish()).toThrow("no longer available");
});

it("reads threaded replies through the owned thread and releases it on completion", async () => {
  const f = await fixture();
  const pending = f.publish(f.prepare("Show Paris"));
  expect(f.session.thread).toHaveBeenCalledWith("map-channel", pending.root);
  const next = { ...INITIAL_MAP, center: [2.35, 48.86] };
  act(() =>
    f.thread.set({
      replies: [
        { ...f.reply(pending.request, next), threadRootId: pending.root },
      ],
    }),
  );
  expect(f.window.snapshot().rows).toHaveLength(1);
  expect(observed.map.state).toEqual(next);
  expect(observed.composer.disabled).toBe(false);
  expect(f.dispose).toHaveBeenCalledOnce();
});
it("does not wait when admission chose reference only for Wintermute", async () => {
  const f = await fixture();
  f.publish(f.prepare("Show Paris"), false);
  expect(observed.composer.disabled).toBe(false);
  expect(f.session.thread).not.toHaveBeenCalled();
});

it("waits for publication before opening the reply reader", async () => {
  const f = await fixture();
  const pending = f.publish(f.prepare("Show Paris"), true, "sending");
  expect(f.session.thread).not.toHaveBeenCalled();
  expect(observed.composer.disabled).toBe(true);
  act(() =>
    f.window.set({
      rows: f.window
        .snapshot()
        .rows.map((row) => ({ ...row, delivery: "accepted" })),
    }),
  );
  expect(f.session.thread).toHaveBeenCalledOnce();
  act(() =>
    f.thread.set({
      replies: [
        {
          ...f.reply(pending.request, INITIAL_MAP),
          threadRootId: pending.root,
        },
      ],
    }),
  );
  expect(observed.composer.disabled).toBe(false);
});

it("opens and closes an existing thread without removing or resetting the map", async () => {
  const f = await fixture();
  const next = { ...INITIAL_MAP, center: [2.35, 48.86] };
  const pending = f.publish(f.prepare("Show Paris"));
  act(() => f.window.set({ rows: [f.reply(pending.request, next)] }));
  act(() => observed.timeline.onOpenThread("reply", "root"));
  expect(screen.getByRole("region", { name: "Thread" })).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Interactive map" }),
  ).toBeInTheDocument();
  expect(observed.map.state).toEqual(next);
  fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
  expect(
    screen.queryByRole("region", { name: "Thread" }),
  ).not.toBeInTheDocument();
  expect(screen.getByTestId("shared-composer")).toBeInTheDocument();
  expect(observed.map.state).toEqual(next);
});

it("prepares thread follow-ups with current map context and the existing thread root", async () => {
  const f = await fixture();
  const request = f.publish(f.prepare("Show Paris"));
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  act(() => observed.timeline.onOpenThread(request.root, request.root));
  act(() => observed.map.onContext({ ...INITIAL_MAP, zoom: 14 }));
  const input = observed.thread.prepareSend({
    content: "Move this marker",
    recipients: [],
  });
  expect(input.content).toContain('"zoom":14');
  expect(input.content).toContain(`--reply-to ${request.root}`);
  const next = { ...INITIAL_MAP, center: [2.35, 48.86] };
  const followup = f.publish(input);
  act(() =>
    f.thread.set({
      replies: [
        { ...f.reply(followup.request, next), threadRootId: request.root },
      ],
    }),
  );
  expect(observed.map.state).toEqual(next);
});

it("has no redundant Maps header and reuses the keyboard-accessible split handle", async () => {
  await fixture();
  expect(screen.queryByText("Maps", { exact: true })).not.toBeInTheDocument();
  const handle = screen.getByRole("separator", {
    name: "Resize main and secondary panels",
  });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(
    document
      .querySelector('[style*="secondary-panel-width"]')
      .style.getPropertyValue("--secondary-panel-width"),
  ).not.toBe("");
});

it("opens the selected channel rather than silently falling back to #map", async () => {
  const f = await fixture({ name: "general", route: "map-channel" });
  expect(screen.getByText("#general")).toBeInTheDocument();
  expect(observed.composer.channelId).toBe("map-channel");
  act(() => f.directory.set({ channels: [] }));
  expect(
    screen.getByText("This channel is no longer available."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Interactive map" }),
  ).not.toBeInTheDocument();
});

it("keeps a complete tool dataset in the app while subsequent agent prompts contain only counts", async () => {
  const f = await fixture();
  const first = f.publish(f.prepare("Plot all sellers"));
  const map = {
    ...INITIAL_MAP,
    markers: Array.from({ length: 500 }, (_, i) => ({
      coordinates: [-122, 37],
      label: `Private seller ${i}`,
    })),
  };
  act(() =>
    f.window.set({ rows: [f.reply(first.request, map)], status: "ready" }),
  );
  expect(observed.map.state.markers).toHaveLength(500);
  const followup = f.prepare("Move the view");
  expect(followup.content).toContain('"markerCount":500');
  expect(followup.content).not.toContain("Private seller");
  const second = f.publish(followup);
  act(() =>
    f.window.set({
      rows: [f.reply(second.request, { center: [2, 3], zoom: 14 })],
      status: "ready",
    }),
  );
  expect(observed.map.state.center).toEqual([2, 3]);
  expect(observed.map.state.markers).toHaveLength(500);
});

it("routes a business pill through the visible shared composer and rechecks channel access", async () => {
  const f = await fixture();
  expect(observed.map.canAddToMessage).toBe(true);
  const insert = observed.map.onAddToMessage;
  const resource = retailerResource(
    { name: "Salon", address: "123 Example St", coordinates: [-122.4, 37.7] },
    "map-channel",
  );
  act(() => expect(insert(resource)).toBe(true));
  expect(f.insertResource).toHaveBeenCalledExactlyOnceWith(resource);
  act(() => f.directory.set({ channels: [] }));
  expect(insert(resource)).not.toBe(true);
  expect(f.insertResource).toHaveBeenCalledTimes(1);
});
it("retains the attached address in agent context and opens a sent reference on the current map", async () => {
  const f = await fixture();
  const resource = retailerResource(
    { name: "Salon", address: "123 Example St", coordinates: [2, 3] },
    "map-channel",
  );
  const prepared = f.prepare(`Tell me about [Salon](${resource.uri})`);
  expect(mapRequest(prepared.content).text).toBe(
    `Tell me about [Salon](${resource.uri})`,
  );
  expect(prepared.content).toContain('"address":"123 Example St"');
  act(() => expect(observed.timeline.onOpenLink(resource.uri)).toBe(true));
  expect(observed.map.state.center).toEqual([2, 3]);
  expect(f.navigation.open).not.toHaveBeenCalled();
});
