import { afterEach, assert, expect, it, vi } from "vitest";
import type { LiveCallbacks, LiveSnapshot } from "../relay/live";
import { createRelaySession } from "../relay/session";
import { flush, keypair, scriptedTransport, signed } from "../relay/testing";
import { connectBrokerTransport } from "../relay/transport";
import { sessionConfigFeed } from "./session-config-feed";

afterEach(() => {
  vi.unstubAllGlobals();
});

const live = { id: "config", status: "live", replay: "unknown" } as const;
const pending = { ...live, status: "pending" } as const;
const connected = (routes: LiveSnapshot["routes"]): LiveSnapshot => ({
  status: "connected",
  routes,
});

/** A real session on a scripted live transport. `merge` holds the session's
 * live-view notifications and replays them once, as `notify` does while an
 * access revocation is in progress (`session.ts`). */
function nativeFeed() {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let callbacks!: LiveCallbacks;
  const scopes: unknown[] = [];
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(input) {
      callbacks = input;
      return {
        update() {},
        retry() {},
        dispose() {},
        configScope(scope) {
          scopes.push(scope);
          // As `live.ts` `sync()`: a changed config filter replaces the route
          // with a `pending` one and notifies synchronously.
          if (scope && callbacks) callbacks.state(connected([pending]));
        },
      };
    },
  });
  const session = owner.session;
  let held: (() => void) | undefined;
  let holding = false;
  const feed = sessionConfigFeed({
    ...session,
    live: {
      snapshot: session.live.snapshot,
      subscribe(listener) {
        held = listener;
        return session.live.subscribe(() => {
          if (!holding) listener();
        });
      },
    },
  });
  assert.exists(feed);
  return {
    owner,
    feed,
    scopes,
    state: (snapshot: LiveSnapshot) => callbacks.state(snapshot),
    callbacks: () => callbacks,
    /** States inside `run` reach the feed as one notification afterwards. */
    merged(run: () => void) {
      holding = true;
      run();
      holding = false;
      held?.();
    },
  };
}

async function bound(f: ReturnType<typeof nativeFeed>) {
  const eose = vi.fn();
  const connection = vi.fn();
  f.feed.connection(connection);
  f.feed.subscribe([{ kinds: [45010], "#h": ["a"], limit: 0 }], {
    event() {},
    eose,
    closed() {},
  });
  f.state(connected([live]));
  await flush();
  expect(eose).toHaveBeenCalledWith(f.feed.generation());
  return { eose, connection };
}

it("scopes the config route to the subscribed channels and closes it with the last", async () => {
  const f = nativeFeed();
  try {
    const stop = f.feed.subscribe([{ kinds: [45010], "#h": ["b"], limit: 0 }], {
      event() {},
      eose() {},
      closed() {},
    });
    const stopRoster = f.feed.subscribe(
      [{ kinds: [39000], "#d": ["a"], limit: 0 }],
      { event() {}, eose() {}, closed() {} },
    );
    expect(f.scopes).toEqual([{ channels: ["b"] }, { channels: ["a", "b"] }]);
    stop();
    stopRoster();
    expect(f.scopes.at(-1)).toBeNull();
  } finally {
    f.owner.dispose();
  }
});

it("delivers config events only to subscriptions whose filters match", async () => {
  const f = nativeFeed();
  try {
    const a = vi.fn(),
      b = vi.fn();
    const handlers = { eose() {}, closed() {} };
    f.feed.subscribe([{ kinds: [45010], "#h": ["a"], limit: 0 }], {
      ...handlers,
      event: a,
    });
    f.feed.subscribe([{ kinds: [45010], "#h": ["b"], limit: 0 }], {
      ...handlers,
      event: b,
    });
    const event = signed(keypair(), {
      kind: 45010,
      content: "{}",
      created_at: 1_700_000_000,
      tags: [["h", "a"]],
    });
    f.callbacks().config?.(event);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).not.toHaveBeenCalled();
  } finally {
    f.owner.dispose();
  }
});

it("native: a connection drop and return inside one merged notification still starts a new generation", async () => {
  const f = nativeFeed();
  try {
    const { eose, connection } = await bound(f);
    const before = f.feed.generation();
    f.merged(() => {
      f.state({ status: "retrying", routes: [pending] });
      f.state(connected([live]));
    });
    expect(f.feed.generation()).not.toBe(before);
    expect(connection).toHaveBeenCalledWith(f.feed.generation());
    expect(eose).toHaveBeenLastCalledWith(f.feed.generation());
  } finally {
    f.owner.dispose();
  }
});

it("native: one config route closed and renewed while the socket stays connected starts a new generation", async () => {
  const f = nativeFeed();
  try {
    const { connection } = await bound(f);
    const before = f.feed.generation();
    f.merged(() => {
      f.state(connected([{ ...live, status: "error", error: "closed" }]));
      f.state(connected([pending]));
      f.state(connected([live]));
    });
    expect(f.feed.generation()).not.toBe(before);
    expect(connection).toHaveBeenCalledTimes(1);
  } finally {
    f.owner.dispose();
  }
});

async function brokerFeed() {
  const relay = keypair(),
    viewer = keypair();
  const bodies: ReadableStreamDefaultController[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/session"))
        return Promise.resolve(
          Response.json({
            viewer: viewer.pubkey,
            relayAuthor: relay.pubkey,
            live: true,
          }),
        );
      if (url.endsWith("/stream"))
        return Promise.resolve(
          new Response(
            new ReadableStream({ start: (c) => void bodies.push(c) }),
            {
              headers: {
                "Content-Type": "text/event-stream",
                "X-Buzz-Live-ID": String(bodies.length + 1).padStart(32, "0"),
              },
            },
          ),
        );
      return Promise.resolve(new Response(null, { status: 200 }));
    }),
  );
  const broker = await connectBrokerTransport();
  const subscribe = broker.subscribe;
  assert.exists(subscribe);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe,
  });
  const feed = sessionConfigFeed(owner.session);
  assert.exists(feed);
  const send = (snapshot: LiveSnapshot, configRevision: number) =>
    bodies
      .at(-1)
      ?.enqueue(
        new TextEncoder().encode(
          `event: state\ndata: ${JSON.stringify({ ...snapshot, configRevision })}\n\n`,
        ),
      );
  return {
    owner,
    feed,
    bodies,
    send,
    dispose() {
      feed.dispose();
      owner.dispose();
    },
  };
}

it("browser: a config route pending and live again back to back through the broker starts a new generation", async () => {
  const { owner, feed, bodies, send } = await brokerFeed();
  try {
    const connection = vi.fn();
    feed.connection(connection);
    feed.subscribe([{ kinds: [45010], "#h": ["a"], limit: 0 }], {
      event() {},
      eose() {},
      closed() {},
    });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    send(connected([live]), 1);
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().routes).toMatchObject([live]),
    );
    const before = feed.generation();
    // Pending and live again in one chunk: the broker never merges config
    // route changes, so the session counts the gap.
    send(connected([pending]), 1);
    send(connected([live]), 1);
    await vi.waitFor(() => expect(connection).toHaveBeenCalledTimes(1));
    expect(feed.generation()).not.toBe(before);
  } finally {
    feed.dispose();
    owner.dispose();
  }
});

it("native: a subscription for a new channel gets no eose until the rescoped route is live", async () => {
  const f = nativeFeed();
  try {
    await bound(f);
    const eose = vi.fn();
    f.feed.subscribe([{ kinds: [45010], "#h": ["b"], limit: 0 }], {
      event() {},
      eose,
      closed() {},
    });
    await flush();
    expect(eose).not.toHaveBeenCalled();
    f.state(connected([live]));
    await flush();
    expect(eose).toHaveBeenCalledWith(f.feed.generation());
  } finally {
    f.owner.dispose();
  }
});

it("browser: a subscription for a new channel gets no eose until the broker reports the new scope live", async () => {
  const b = await brokerFeed();
  try {
    b.feed.subscribe([{ kinds: [45010], "#h": ["a"], limit: 0 }], {
      event() {},
      eose() {},
      closed() {},
    });
    await vi.waitFor(() => expect(b.bodies).toHaveLength(1));
    b.send(connected([live]), 1);
    await vi.waitFor(() =>
      expect(b.owner.session.live.snapshot().routes).toMatchObject([live]),
    );
    const eose = vi.fn();
    b.feed.subscribe([{ kinds: [45010], "#h": ["b"], limit: 0 }], {
      event() {},
      eose,
      closed() {},
    });
    await flush();
    expect(eose).not.toHaveBeenCalled();
    // A state frame still stamped with the old scope's revision is fenced.
    b.send(connected([live]), 1);
    await flush();
    expect(eose).not.toHaveBeenCalled();
    b.send(connected([live]), 2);
    await vi.waitFor(() => expect(eose).toHaveBeenCalledTimes(1));
  } finally {
    b.dispose();
  }
});

it("matches authors and ids, and refuses filter keys it cannot match", async () => {
  const f = nativeFeed();
  try {
    const author = keypair();
    const event = signed(author, {
      kind: 45010,
      content: "{}",
      created_at: 1_700_000_000,
      tags: [["h", "a"]],
    });
    const handlers = { eose() {}, closed() {} };
    const mine = vi.fn(),
      other = vi.fn(),
      byId = vi.fn();
    f.feed.subscribe([{ kinds: [45010], authors: [author.pubkey], limit: 0 }], {
      ...handlers,
      event: mine,
    });
    f.feed.subscribe(
      [{ kinds: [45010], authors: [keypair().pubkey], limit: 0 }],
      { ...handlers, event: other },
    );
    f.feed.subscribe([{ ids: [event.id], limit: 0 }], {
      ...handlers,
      event: byId,
    });
    f.callbacks().config?.(event);
    expect(mine).toHaveBeenCalledWith(event);
    expect(byId).toHaveBeenCalledWith(event);
    expect(other).not.toHaveBeenCalled();
    expect(() =>
      f.feed.subscribe([{ kinds: [45010], since: 1, limit: 0 } as never], {
        ...handlers,
        event() {},
      }),
    ).toThrow("Unsupported config filter key: since");
  } finally {
    f.owner.dispose();
  }
});

it("gives a route that recovers from a reported failure a new generation", async () => {
  const f = nativeFeed();
  try {
    const { eose, connection } = await bound(f);
    const closed = vi.fn();
    f.feed.subscribe([{ kinds: [45010], "#h": ["a"], limit: 0 }], {
      event() {},
      eose,
      closed,
    });
    await flush();
    f.state(connected([{ ...live, status: "error", error: "blocked" }]));
    await flush();
    const failed = closed.mock.lastCall?.[0];
    expect(failed).toBe(f.feed.generation());
    // Retry recovers the route on the same socket.
    f.state(connected([pending]));
    f.state(connected([live]));
    await flush();
    expect(f.feed.generation()).not.toBe(failed);
    expect(eose).toHaveBeenLastCalledWith(f.feed.generation());
    expect(connection).toHaveBeenLastCalledWith(f.feed.generation());
  } finally {
    f.owner.dispose();
  }
});
