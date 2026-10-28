// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createReadApi,
  type ReadApiHost,
  type ReadIntent,
  type ServerChannelRow,
  type SidebarPage,
} from "./read-api";
import type { RelayEvent } from "./events";

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const channel = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const id = (n: number) => n.toString(16).padStart(64, "0");

const row = (
  patch: Partial<ServerChannelRow> & { channel_id?: string } = {},
): ServerChannelRow => ({
  channel_id: channel,
  unread: false,
  mentions: 0,
  read_through_id: id(1),
  latest_id: id(1),
  threads: [],
  ...patch,
});
const page = (...channels: ServerChannelRow[]): SidebarPage => ({
  channels,
  next_cursor: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function fakeHost() {
  const sidebar = vi.fn<ReadApiHost["sidebar"]>();
  const write = vi.fn<ReadApiHost["write"]>();
  const host: ReadApiHost = {
    capabilities: ["follow", "threads", "ping"],
    eligibleKinds: [9],
    maxChannels: 20,
    maxIntents: 100,
    sidebar,
    write,
  };
  return { host, sidebar, write };
}
const message = (
  n: number,
  patch: Partial<RelayEvent> = {},
  tags: string[][] = [],
): RelayEvent =>
  ({
    id: id(n),
    pubkey: other,
    kind: 9,
    created_at: 1_700_000_000 + n,
    content: "",
    sig: "",
    tags: [["h", channel], ...tags],
    ...patch,
  }) as RelayEvent;
const create = (host: ReadApiHost, storageKey?: string) =>
  createReadApi({
    host,
    viewer,
    storageKey,
    isDm: () => false,
    rootAuthor: () => undefined,
  });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

it("an older targeted response cannot restore unread a newer one cleared", async () => {
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce(page(row()));
  const api = create(host, "k");
  await api.load();
  const older = deferred<SidebarPage>();
  const newer = deferred<SidebarPage>();
  sidebar.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(50);
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(50);
  newer.resolve(page(row({ read_through_id: id(3), latest_id: id(3) })));
  await vi.advanceTimersByTimeAsync(0);
  older.resolve(page(row({ unread: true, mentions: 1, latest_id: id(3) })));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.row(channel)).toMatchObject({ unread: false, mentions: 0 });
  api.dispose();
});

it("a full load issued before a targeted refresh keeps the refreshed channel", async () => {
  const { host, sidebar } = fakeHost();
  const full = deferred<SidebarPage>();
  sidebar.mockReturnValueOnce(full.promise);
  const api = create(host, "k");
  const loading = api.load();
  sidebar.mockResolvedValueOnce(page(row()));
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(50);
  full.resolve(
    page(
      row({ unread: true, latest_id: id(2) }),
      row({ channel_id: second, unread: true }),
    ),
  );
  await loading;
  expect(api.row(channel)?.unread).toBe(false);
  expect(api.row(second)?.unread).toBe(true);
  expect(api.complete()).toBe(true);
  api.dispose();
});

it("a live arrival newer than a response survives it and refetches", async () => {
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce(page(row()));
  const api = create(host, "k");
  await api.load();
  const held = deferred<SidebarPage>();
  sidebar.mockReturnValueOnce(held.promise);
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(50);
  api.observe(message(5));
  expect(api.row(channel)).toMatchObject({ unread: true, latest_id: id(5) });
  sidebar.mockResolvedValueOnce(page(row({ unread: true, latest_id: id(5) })));
  held.resolve(page(row()));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.row(channel)?.unread).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(sidebar).toHaveBeenLastCalledWith(
    { channelIds: [channel] },
    expect.anything(),
  );
  api.dispose();
});

it("a failed targeted refresh repairs with a full load", async () => {
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce(page(row()));
  const api = create(host, "k");
  await api.load();
  sidebar.mockRejectedValueOnce(new Error("offline"));
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(50);
  sidebar.mockResolvedValueOnce(page(row({ unread: true, latest_id: id(2) })));
  await vi.advanceTimersByTimeAsync(2000);
  expect(sidebar).toHaveBeenLastCalledWith({}, expect.anything());
  expect(api.row(channel)?.unread).toBe(true);
  api.dispose();
});

it("first launch starts the account once per install", async () => {
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValue(page(row()));
  write.mockResolvedValue({ outcomes: [{ status: "applied" }] });
  const api = create(host, "k");
  await api.load();
  await vi.advanceTimersByTimeAsync(150);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[0]).toEqual([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: id(1),
    },
  ]);
  api.dispose();
  const again = create(host, "k");
  await again.load();
  await vi.advanceTimersByTimeAsync(150);
  expect(write).toHaveBeenCalledTimes(1);
  again.dispose();
});

it("keeps unresolved intents across restarts and retries with backoff", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValue(page(row({ unread: true, latest_id: id(2) })));
  write.mockRejectedValue(new Error("offline"));
  const intent: ReadIntent = {
    type: "mark_through",
    target: { channel_id: channel },
    message_id: id(2),
  };
  const api = create(host, "k");
  await api.load();
  api.enqueue([intent]);
  await vi.advanceTimersByTimeAsync(150);
  expect(write).toHaveBeenCalledTimes(1);
  api.dispose();
  expect(JSON.parse(localStorage.getItem("k") ?? "[]")).toEqual([intent]);

  write.mockReset();
  write
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ outcomes: [{ status: "applied" }] });
  const restarted = create(host, "k");
  await restarted.load();
  expect(write).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]?.[0]).toEqual([intent]);
  expect(localStorage.getItem("k")).toBeNull();
  restarted.dispose();
});

it("skips its own ping and refreshes the channels another install's ping names", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValue(page(row({ unread: true, latest_id: id(2) })));
  write.mockResolvedValue({
    outcomes: [{ status: "applied" }],
    channels: [row({ read_through_id: id(2), latest_id: id(2) })],
    ping_id: id(99),
  });
  const api = create(host, "k");
  await api.load();
  api.readLocally(channel, undefined, id(2));
  api.enqueue([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: id(2),
    },
  ]);
  await vi.advanceTimersByTimeAsync(150);
  const loads = sidebar.mock.calls.length;
  api.changed(JSON.stringify({ channels: [channel], threads: [] }), id(99));
  await vi.advanceTimersByTimeAsync(50);
  expect(sidebar.mock.calls.length).toBe(loads);
  api.changed(
    JSON.stringify({
      channels: [],
      threads: [{ channel_id: second, root_id: id(7) }],
    }),
    id(100),
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(sidebar).toHaveBeenLastCalledWith(
    { channelIds: [second] },
    expect.anything(),
  );
  api.dispose();
});

it("counts live mentions and follows replies only in listed threads", async () => {
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValue(
    page(
      row({
        threads: [
          {
            root_id: id(10),
            unread: false,
            mentions: 0,
            read_through_id: id(11),
            latest_id: id(11),
          },
        ],
      }),
    ),
  );
  const api = create(host, "k");
  await api.load();
  api.observe(message(2, {}, [["p", viewer]]));
  expect(api.row(channel)).toMatchObject({ unread: true, mentions: 1 });
  api.observe(message(12, {}, [["e", id(10), "", "reply"]]));
  expect(api.row(channel)?.threads[0]).toMatchObject({
    root_id: id(10),
    unread: true,
    latest_id: id(12),
  });
  api.observe(message(21, {}, [["e", id(20), "", "reply"]]));
  expect(api.row(channel)?.threads).toHaveLength(1);
  api.observe(message(3, { pubkey: viewer }));
  expect(api.row(channel)).toMatchObject({
    unread: false,
    mentions: 0,
    read_through_id: id(3),
  });
  api.dispose();
});

it("drops a response read at an older revision than one already seen and asks again", async () => {
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce({ ...page(row()), read_revision: 4 });
  const api = create(host, "k");
  await api.load();
  sidebar
    .mockResolvedValueOnce({
      ...page(row({ unread: true, latest_id: id(2) })),
      read_revision: 3,
    })
    .mockResolvedValueOnce({
      ...page(row({ read_through_id: id(2), latest_id: id(2) })),
      read_revision: 5,
    });
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.row(channel)?.unread).toBe(false);
  await vi.advanceTimersByTimeAsync(50);
  expect(sidebar).toHaveBeenCalledTimes(3);
  expect(api.row(channel)?.read_through_id).toBe(id(2));
  expect(api.stale(4)).toBe(true);
  expect(api.stale(5)).toBe(false);
  api.dispose();
});

it("on wake, probes one channel and loads everything only when the revision moved", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce({ ...page(row()), read_revision: 7 });
  const api = create(host, "k");
  await api.load();
  const hide = (state: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  sidebar.mockResolvedValueOnce({ ...page(row()), read_revision: 7 });
  hide("hidden");
  await vi.advanceTimersByTimeAsync(31000);
  hide("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(sidebar).toHaveBeenCalledTimes(2);
  expect(sidebar).toHaveBeenLastCalledWith(
    { channelIds: [channel] },
    expect.anything(),
  );

  sidebar
    .mockResolvedValueOnce({ ...page(row()), read_revision: 8 })
    .mockResolvedValueOnce({
      ...page(row(), row({ channel_id: second, unread: true })),
      read_revision: 8,
    });
  hide("hidden");
  await vi.advanceTimersByTimeAsync(31000);
  hide("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(sidebar).toHaveBeenCalledTimes(4);
  expect(sidebar).toHaveBeenLastCalledWith({}, expect.anything());
  expect(api.row(second)?.unread).toBe(true);
  api.dispose();
});

it("a ping that starts past the reconciled revision reloads everything", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValue({
    ...page(row(), row({ channel_id: second })),
    read_revision: 45,
  });
  const api = create(host, "k");
  await api.load();
  const ping = (from: number, to: number, channelId: string) =>
    JSON.stringify({
      read_revision_from: from,
      read_revision: to,
      channels: [channelId],
      threads: [],
    });
  // Contiguous: only the named channel.
  sidebar.mockResolvedValueOnce({ ...page(row()), read_revision: 46 });
  api.changed(ping(45, 46, channel), id(200));
  await vi.advanceTimersByTimeAsync(50);
  expect(sidebar).toHaveBeenLastCalledWith(
    { channelIds: [channel] },
    expect.anything(),
  );
  const calls = sidebar.mock.calls.length;
  // 47 was dropped; 48 starts past what was reconciled.
  sidebar.mockResolvedValue({
    ...page(row(), row({ channel_id: second })),
    read_revision: 48,
  });
  api.changed(ping(47, 48, second), id(201));
  await vi.advanceTimersByTimeAsync(50);
  // The missing ping gets a moment to arrive before everything reloads.
  expect(sidebar.mock.calls.slice(calls).map(([query]) => query)).toEqual([
    { channelIds: [second] },
  ]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(sidebar.mock.calls.slice(calls).map(([query]) => query)).toEqual([
    { channelIds: [second] },
    {},
  ]);
  api.dispose();
});

it("waits out pings held behind a concurrent own write instead of reloading", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValue({ ...page(row()), read_revision: 431 });
  const api = create(host, "k");
  await api.load();
  sidebar.mockResolvedValue({ ...page(row()), read_revision: 434 });
  const calls = sidebar.mock.calls.length;
  const ping = (from: number, to: number) =>
    JSON.stringify({
      read_revision_from: from,
      read_revision: to,
      channels: [channel],
      threads: [],
    });
  // Two other installs mark the same message first; their pings land while
  // this install's write is in flight and wait for its answer, 433..434.
  let answer!: () => void;
  write.mockImplementationOnce(
    (intents) =>
      new Promise((resolve) => {
        answer = () =>
          resolve({
            outcomes: intents.map(() => ({ status: "applied" })),
            read_revision_from: 433,
            read_revision: 434,
            ping_id: id(302),
          });
      }),
  );
  api.enqueue([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: id(1),
    },
  ]);
  await vi.advanceTimersByTimeAsync(150);
  api.changed(ping(431, 432), id(300));
  api.changed(ping(432, 433), id(301));
  api.changed(ping(433, 434), id(302));
  answer();
  await vi.advanceTimersByTimeAsync(3000);
  const queries = sidebar.mock.calls.slice(calls).map(([query]) => query);
  expect(queries).not.toContainEqual({});
  expect(queries.length).toBeGreaterThan(0);
  api.dispose();
});

it("keeps current rows when every traversal mixes revisions, then repairs", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce({ ...page(row()), read_revision: 5 });
  const api = create(host, "k");
  await api.load();
  // Each traversal: page one is older than page two, and nothing covers it.
  let revision = 5;
  sidebar.mockImplementation(async (query) =>
    query.cursor
      ? { ...page(row({ channel_id: second })), read_revision: ++revision }
      : {
          channels: [row({ unread: true, latest_id: id(9) })],
          next_cursor: "next",
          read_revision: revision,
        },
  );
  await api.load();
  expect(sidebar).toHaveBeenCalledTimes(7);
  expect(api.row(channel)?.unread).toBe(false);
  expect(api.row(second)).toBeUndefined();
  expect(api.status()).toMatchObject({ status: "error" });
  sidebar.mockResolvedValue({
    ...page(row({ unread: true, latest_id: id(9) })),
    read_revision: 20,
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.row(channel)?.unread).toBe(true);
  expect(api.status()).toMatchObject({ status: "ready" });
  api.dispose();
});

it("accepts a traversal whose newer revisions arrived as pings while it ran", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  const second_page = deferred<SidebarPage>();
  sidebar
    .mockResolvedValueOnce({
      channels: [row({ unread: true, latest_id: id(9) })],
      next_cursor: "next",
      read_revision: 5,
    })
    .mockReturnValueOnce(second_page.promise);
  const api = create(host, "k");
  const loading = api.load();
  await vi.advanceTimersByTimeAsync(0);
  sidebar.mockResolvedValue({
    ...page(row({ read_through_id: id(9), latest_id: id(9) })),
    read_revision: 6,
  });
  api.changed(
    JSON.stringify({
      read_revision_from: 5,
      read_revision: 6,
      channels: [channel],
      threads: [],
    }),
    id(300),
  );
  await vi.advanceTimersByTimeAsync(50);
  second_page.resolve({
    ...page(row({ channel_id: second })),
    read_revision: 6,
  });
  await loading;
  expect(sidebar).toHaveBeenCalledTimes(3);
  expect(api.row(channel)?.unread).toBe(false);
  expect(api.row(second)).toBeDefined();
  expect(api.status()).toMatchObject({ status: "ready" });
  api.dispose();
});

it("without followed_threads, a reply in a remembered thread asks the relay whether it is still followed", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  const thread = (latest: number) => ({
    root_id: id(10),
    unread: true,
    mentions: 0,
    read_through_id: null,
    latest_id: id(latest),
  });
  sidebar.mockResolvedValueOnce(page(row({ threads: [thread(11)] })));
  write.mockResolvedValue({ outcomes: [{ status: "applied" }] });
  const api = create(host, "k");
  await api.load();
  api.readLocally(channel, id(10), id(11));
  expect(api.following(channel, id(10))).toBe(true);
  // Still followed: the relay lists it.
  sidebar.mockResolvedValueOnce(page(row({ threads: [thread(12)] })));
  api.observe(message(12, {}, [["e", id(10), "", "reply"]]));
  expect(api.row(channel)?.threads).toEqual([]);
  await vi.advanceTimersByTimeAsync(1050);
  expect(api.row(channel)?.threads[0]).toMatchObject({ latest_id: id(12) });
  // Unfollowed on another install: the relay does not list it.
  api.readLocally(channel, id(10), id(12));
  sidebar.mockResolvedValueOnce(page(row()));
  api.observe(message(13, {}, [["e", id(10), "", "reply"]]));
  await vi.advanceTimersByTimeAsync(1050);
  expect(api.row(channel)?.threads).toEqual([]);
  expect(api.following(channel, id(10))).toBe(false);
  // Known unfollowed: no request at all.
  const calls = sidebar.mock.calls.length;
  api.observe(message(14, {}, [["e", id(10), "", "reply"]]));
  await vi.advanceTimersByTimeAsync(1050);
  expect(sidebar.mock.calls.length).toBe(calls);
  expect(api.row(channel)?.threads).toEqual([]);
  api.dispose();
});

const reply = (n: number, root: number, patch: Partial<RelayEvent> = {}) =>
  message(n, patch, [["e", id(root), "", "reply"]]);

it("followed_threads decides live replies; queued intents win until applied", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValueOnce({
    ...page(row({ followed_threads: [id(10)] })),
    read_revision: 3,
  });
  const api = create(host, "k");
  await api.load();
  expect(api.following(channel, id(10))).toBe(true);
  expect(api.following(channel, id(20))).toBe(false);
  // Listed: lights at once, no request.
  api.observe(reply(11, 10));
  expect(api.row(channel)?.threads[0]).toMatchObject({ latest_id: id(11) });
  // Unlisted and not truncated: not followed, no request.
  api.observe(reply(21, 20));
  await vi.advanceTimersByTimeAsync(1050);
  expect(sidebar).toHaveBeenCalledTimes(1);
  expect(api.row(channel)?.threads).toHaveLength(1);
  // Unfollowed on another install: the refreshed row decides.
  sidebar.mockResolvedValueOnce({
    ...page(row({ followed_threads: [] })),
    read_revision: 4,
  });
  api.changed(
    JSON.stringify({
      read_revision_from: 3,
      read_revision: 4,
      channels: [channel],
    }),
    id(400),
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(api.following(channel, id(10))).toBe(false);
  api.observe(reply(12, 10));
  expect(api.row(channel)?.threads).toEqual([]);
  // A follow intent counts while queued, even over a row read before it applied.
  const applied = deferred<Awaited<ReturnType<ReadApiHost["write"]>>>();
  write.mockReturnValueOnce(applied.promise);
  api.enqueue([
    { type: "follow", target: { channel_id: channel, root_id: id(10) } },
  ]);
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(200);
  expect(api.following(channel, id(10))).toBe(true);
  api.observe(reply(13, 10));
  expect(api.row(channel)?.threads[0]).toMatchObject({ latest_id: id(13) });
  sidebar.mockResolvedValueOnce({
    ...page(row({ followed_threads: [id(10)] })),
    read_revision: 5,
  });
  applied.resolve({
    outcomes: [{ status: "applied" }],
    read_revision: 5,
    read_revision_from: 4,
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(api.following(channel, id(10))).toBe(true);
  api.dispose();
});

it("past the cap, an unlisted reply asks once per root until the revision moves", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  const truncated = (revision: number, followed: number[] = []) => ({
    ...page(
      row({
        followed_threads: followed.map(id),
        followed_threads_truncated: true,
      }),
    ),
    read_revision: revision,
  });
  sidebar.mockResolvedValueOnce(truncated(3));
  const api = create(host, "k");
  await api.load();
  expect(api.following(channel, id(20))).toBeUndefined();
  sidebar.mockResolvedValueOnce(truncated(3));
  api.observe(reply(21, 20));
  api.observe(reply(22, 20));
  await vi.advanceTimersByTimeAsync(999);
  expect(sidebar).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(51);
  expect(sidebar).toHaveBeenCalledTimes(2);
  expect(api.row(channel)?.threads).toEqual([]);
  expect(api.following(channel, id(20))).toBe(false);
  // Not followed as of revision 3: further replies ask nothing.
  api.observe(reply(23, 20));
  await vi.advanceTimersByTimeAsync(1050);
  expect(sidebar).toHaveBeenCalledTimes(2);
  // The row moved past it: ask again; now listed.
  sidebar.mockResolvedValueOnce(truncated(4));
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.following(channel, id(20))).toBeUndefined();
  sidebar.mockResolvedValueOnce(truncated(4, [20]));
  api.observe(reply(24, 20));
  await vi.advanceTimersByTimeAsync(1050);
  expect(sidebar).toHaveBeenCalledTimes(4);
  expect(api.following(channel, id(20))).toBe(true);
  api.dispose();
});

it("an own new root counts as followed until the relay's next row", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce(page(row({ followed_threads: [] })));
  const api = create(host, "k");
  await api.load();
  api.observe(message(5, { pubkey: viewer }));
  expect(api.following(channel, id(5))).toBe(true);
  api.observe(reply(6, 5));
  expect(api.row(channel)?.threads[0]).toMatchObject({ root_id: id(5) });
  api.dispose();
});

it("sends follow, unfollow, follow in order instead of dropping the repeat", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValue(page(row()));
  write.mockImplementation(async (intents) => ({
    outcomes: intents.map(() => ({ status: "applied" })),
  }));
  const api = create(host, "k");
  await api.load();
  const target = { channel_id: channel, root_id: id(10) };
  api.enqueue([{ type: "follow", target }]);
  api.enqueue([{ type: "unfollow", target }]);
  api.enqueue([{ type: "follow", target }]);
  await vi.advanceTimersByTimeAsync(150);
  expect(
    write.mock.calls.flatMap(([intents]) => intents.map((i) => i.type)),
  ).toEqual(["follow", "unfollow", "follow"]);
  expect(api.following(channel, id(10))).toBe(true);
  api.dispose();
});

it("counts a repeated live delivery once and asks about an unknown channel once", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValue(page(row()));
  const api = create(host, "k");
  await api.load();
  const mention = message(2, {}, [["p", viewer]]);
  api.observe(mention);
  api.observe(mention);
  expect(api.row(channel)?.mentions).toBe(1);
  const elsewhere = (n: number) => message(n, { tags: [["h", second]] });
  api.observe(elsewhere(3));
  api.observe(elsewhere(4));
  await vi.advanceTimersByTimeAsync(50);
  api.observe(elsewhere(5));
  await vi.advanceTimersByTimeAsync(50);
  expect(sidebar.mock.calls.filter(([query]) => query.channelIds)).toHaveLength(
    1,
  );
  api.dispose();
});

it("drops a write batch the relay refuses as malformed", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValue(page(row()));
  write
    .mockRejectedValueOnce(
      Object.assign(new Error("Read write failed (400)"), { status: 400 }),
    )
    .mockResolvedValue({ outcomes: [{ status: "applied" }] });
  const api = create(host, "k");
  await api.load();
  api.enqueue([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: id(1),
    },
  ]);
  await vi.advanceTimersByTimeAsync(150);
  expect(api.status().pending).toBe(0);
  api.enqueue([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: id(2),
    },
  ]);
  await vi.advanceTimersByTimeAsync(1150);
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]?.[0]).toHaveLength(1);
  api.dispose();
});

it("a targeted refresh that keeps coming back stale falls back to a full load", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar } = fakeHost();
  sidebar.mockResolvedValueOnce({ ...page(row()), read_revision: 5 });
  const api = create(host, "k");
  await api.load();
  sidebar.mockResolvedValue({ ...page(row()), read_revision: 4 });
  api.refresh([channel]);
  await vi.advanceTimersByTimeAsync(1000);
  // One ask plus three re-asks, then the full-load repair after its backoff.
  expect(sidebar.mock.calls.filter(([query]) => query.channelIds)).toHaveLength(
    4,
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(
    sidebar.mock.calls.filter(([query]) => !query.channelIds).length,
  ).toBeGreaterThan(1);
  api.dispose();
});

it("a write answer without the follow list keeps the last one, and the applied intent still wins", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValueOnce({
    ...page(row({ followed_threads: [id(10)] })),
    read_revision: 3,
  });
  write.mockResolvedValue({
    outcomes: [{ status: "applied" }],
    channels: [row()],
    read_revision: 4,
    read_revision_from: 3,
  });
  const api = create(host, "k");
  await api.load();
  api.enqueue([
    { type: "unfollow", target: { channel_id: channel, root_id: id(10) } },
  ]);
  await vi.advanceTimersByTimeAsync(150);
  expect(api.status().pending).toBe(0);
  expect(api.row(channel)?.followed_threads).toEqual([id(10)]);
  expect(api.following(channel, id(10))).toBe(false);
  expect(api.following(channel, id(20))).toBe(false);
  api.observe(reply(11, 10));
  expect(api.row(channel)?.threads).toEqual([]);
  api.dispose();
});

it("a periodic probe after this install's own marks stays one targeted read", async () => {
  localStorage.setItem("k:started", "1");
  const { host, sidebar, write } = fakeHost();
  sidebar.mockResolvedValueOnce({ ...page(row()), read_revision: 7 });
  const api = create(host, "k");
  await api.load();
  write.mockResolvedValueOnce({
    outcomes: [{ status: "applied" }],
    channels: [row({ read_through_id: id(2), latest_id: id(2) })],
    read_revision: 8,
    read_revision_from: 7,
  });
  api.enqueue([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: id(2),
    },
  ]);
  await vi.advanceTimersByTimeAsync(150);
  sidebar.mockResolvedValue({ ...page(row()), read_revision: 8 });
  await api.probe();
  await api.probe();
  expect(sidebar).toHaveBeenCalledTimes(3);
  expect(sidebar).toHaveBeenLastCalledWith(
    { channelIds: [channel] },
    expect.anything(),
  );
  // Another install's mark whose ping was missed: the probe sees it.
  sidebar.mockResolvedValue({ ...page(row()), read_revision: 9 });
  await api.probe();
  expect(sidebar).toHaveBeenLastCalledWith({}, expect.anything());
  api.dispose();
});
