import { afterEach, assert, expect, it, vi } from "vitest";
import {
  configFilters,
  createLiveAdmission,
  type LiveCallbacks,
  subscribeRelayTraffic,
} from "./live";
import { keypair, signed } from "./testing";

type Filter = Record<string, unknown>;
type Request = [string, string, ...Filter[]];
class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  requests() {
    return this.sent.filter((entry) => entry[0] === "REQ") as Request[];
  }
  config() {
    return this.requests().filter((r) =>
      (r.slice(2) as Filter[]).some((f) => f["#P"] !== undefined),
    );
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((entry) => entry[0] === "AUTH")?.[1] as {
      id: string;
    };
    await this.receive(["OK", event.id, true]);
  }
}
afterEach(() => vi.useRealTimers());

function setup() {
  const key = keypair();
  const sockets: Socket[] = [];
  const callbacks = {
    receive: vi.fn(),
    config: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  } satisfies LiveCallbacks;
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    callbacks,
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    createLiveAdmission(),
  );
  const routes = () =>
    callbacks.state.mock.lastCall?.[0].routes.filter((r) =>
      r.id.startsWith("config"),
    ) ?? [];
  return { key, sockets, callbacks, owner, routes };
}

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `c${String(i).padStart(3, "0")}`);

it("config scope sends fixed live-only filters and routes traffic only to config", async () => {
  vi.useFakeTimers();
  const h = setup();
  const socket = h.sockets[0];
  assert.exists(socket);
  await socket.auth();
  h.owner.configScope?.({ channels: ids(12) });
  await vi.advanceTimersByTimeAsync(750);
  const [request] = socket.config();
  assert.exists(request);
  const filters = request.slice(2) as Filter[];
  expect(filters).toEqual([
    {
      kinds: [39000],
      "#P": [h.key.pubkey],
      since: expect.any(Number),
      limit: 0,
    },
    {
      kinds: [45010, 45011, 9005],
      "#h": ids(10),
      since: expect.any(Number),
      limit: 0,
    },
    {
      kinds: [39000, 39002],
      "#d": ids(10),
      since: expect.any(Number),
      limit: 0,
    },
    {
      kinds: [45010, 45011, 9005],
      "#h": ids(12).slice(10),
      since: expect.any(Number),
      limit: 0,
    },
    {
      kinds: [39000, 39002],
      "#d": ids(12).slice(10),
      since: expect.any(Number),
      limit: 0,
    },
  ]);
  expect(h.routes()).toEqual([
    expect.objectContaining({ id: "config", status: "pending" }),
  ]);

  await socket.receive(["EOSE", request[1]]);
  expect(h.routes()).toEqual([
    expect.objectContaining({ id: "config", status: "live" }),
  ]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  const revision = signed(keypair(), {
    kind: 45010,
    content: "x",
    created_at: 1_700_000_000,
    tags: [["h", "c000"]],
  });
  await socket.receive(["EVENT", request[1], revision]);
  expect(h.callbacks.config).toHaveBeenCalledWith(revision);
  expect(h.callbacks.receive).not.toHaveBeenCalled();

  // An equal scope keeps the wire; null closes it and drops the route.
  const sent = socket.sent.length;
  h.owner.configScope?.({ channels: [...ids(12)].reverse() });
  expect(socket.sent).toHaveLength(sent);
  h.owner.configScope?.(null);
  expect(socket.sent.at(-1)).toEqual(["CLOSE", request[1]]);
  expect(h.routes()).toEqual([]);
  h.owner.dispose();
});

it("config filters split into REQs of at most ten filters", () => {
  const requests = configFilters("p".repeat(64), ids(50));
  expect([...requests.keys()]).toEqual(["config", "config:1"]);
  expect([...requests.values()].map((f) => f.length)).toEqual([10, 1]);
  expect(configFilters("p".repeat(64), [])).toEqual(
    new Map([["config", [{ kinds: [39000], "#P": ["p".repeat(64)] }]]]),
  );
});

it("a reconnect returns the config route to pending and re-sends it on the new socket", async () => {
  vi.useFakeTimers();
  const h = setup();
  const first = h.sockets[0];
  assert.exists(first);
  await first.auth();
  h.owner.configScope?.({ channels: ids(2) });
  await vi.advanceTimersByTimeAsync(750);
  const [request] = first.config();
  assert.exists(request);
  await first.receive(["EOSE", request[1]]);
  expect(h.routes()[0]?.status).toBe("live");

  first.close();
  expect(h.routes()[0]?.status).toBe("pending");
  await vi.advanceTimersByTimeAsync(5_000);
  const second = h.sockets[1];
  assert.exists(second);
  await second.auth();
  await vi.advanceTimersByTimeAsync(750);
  const [again] = second.config();
  assert.exists(again);
  expect(again.slice(2)).toEqual(
    (request.slice(2) as Filter[]).map((f) => ({
      ...f,
      since: expect.any(Number),
    })),
  );
  // A late frame from the old socket's wire cannot reach the new route.
  await first.receive(["EOSE", request[1]]);
  expect(h.routes()[0]?.status).toBe("pending");
  await second.receive(["EOSE", again[1]]);
  expect(h.routes()[0]?.status).toBe("live");
  h.owner.dispose();
});
