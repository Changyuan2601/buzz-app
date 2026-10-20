import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { nativeSocket } from "./native-socket";
import { subscribeRelayTraffic, type LiveCallbacks } from "./live";
import { keypair, signed } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function connect() {
  const key = keypair();
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  } satisfies LiveCallbacks;
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    callbacks,
    nativeSocket,
  );
  return { owner, callbacks };
}
it.each([
  "Federated community discovery failed",
  "Native sockets are busy",
  "Native socket timed out",
  "Native socket upgrade refused",
])(
  "re-enters live reconnect after transient native admission: %s",
  async (error) => {
    vi.useFakeTimers();
    // Pin reconnect jitter to its full base delay.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const first = deferred<"public">();
    const next = deferred<"public">();
    let attempts = 0;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "relay_socket_connect"
        ? (++attempts === 1 ? first : next).promise
        : Promise.resolve(),
    );
    const h = connect();
    try {
      expect(attempts).toBe(1);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connecting");
      first.reject(error);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
      await vi.advanceTimersByTimeAsync(499);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
    } finally {
      h.owner.dispose();
      next.resolve("public");
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);
it("reconnects when native admission succeeds but starting the worker fails", async () => {
  vi.useFakeTimers();
  const start = deferred<void>();
  const next = deferred<"public">();
  let attempts = 0;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "relay_socket_connect")
      return ++attempts === 1 ? Promise.resolve("native") : next.promise;
    if (command === "relay_socket_start") return start.promise;
    return Promise.resolve();
  });
  const h = connect();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith(
      "relay_socket_start",
      expect.any(Object),
    );
    start.reject("Native socket retired");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
  } finally {
    h.owner.dispose();
    start.resolve();
    next.resolve("public");
    await vi.advanceTimersByTimeAsync(0);
  }
});
it.each([
  "Federated sign-in is required",
  "binding-mismatch",
  "authorization-denied",
  "invalid-proof",
])(
  "keeps native credential refusal explicit without reconnect: %s",
  async (error) => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation((command) =>
      command === "relay_socket_connect"
        ? Promise.reject(error)
        : Promise.resolve(),
    );
    const h = connect();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        error,
      });
      await vi.advanceTimersByTimeAsync(60000);
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === "relay_socket_connect"),
      ).toHaveLength(1);
    } finally {
      h.owner.dispose();
    }
  },
);
