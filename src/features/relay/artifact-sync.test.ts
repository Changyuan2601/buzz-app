import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../artifact-storage/service";
import { provideArtifactSync } from "./artifact-sync";
import { reconcileArtifactSnapshot } from "./artifact-reconcile";
import { keypair, signed } from "./testing";
import { eventDto, type RelayEvent } from "./events";
vi.mock("./artifact-reconcile", async (original) => ({
  ...(await original<typeof import("./artifact-reconcile")>()),
  reconcileArtifactSnapshot: vi.fn(async () => {}),
}));
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", {
    locks: { request: vi.fn(async (_key, _options, callback) => callback()) },
  });
  const listeners = new Set<() => void>();
  let confirmed: (events: readonly RelayEvent[]) => void = () => {};
  let opened: (entry: OpenArtifactCollection) => void = () => {};
  let online = true;
  const session = {
    artifactSnapshots: {},
    live: {
      snapshot: () => ({ status: online ? "connected" : "retrying" }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    channels: { subscribeList: () => () => {} },
    subscribeLive: () => () => {},
    subscribeArtifactUpdates: (listener: typeof confirmed) => {
      confirmed = listener;
      return () => {
        confirmed = () => {};
      };
    },
  };
  const snapshot = () => ({
    viewer: "viewer",
    origin: "https://relay.test",
    status: "ready",
    cached: false,
    session,
  });
  const ctx = {
    relay: {
      snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    effect: (effect: () => () => void) => {
      stops.push(effect());
    },
  };
  const storage = {
    onOpen: (listener: typeof opened) => {
      opened = listener;
      return () => {};
    },
  };
  provideArtifactSync(
    ctx as unknown as Context,
    storage as unknown as ArtifactStorageService,
  );
  const add = () => {
    const controller = new AbortController();
    const collection = { applyBatch: vi.fn(async () => {}) };
    opened({
      viewer: "viewer",
      relay: "https://relay.test",
      owner: "test.plugin",
      definition: { name: "tasks", type: "test.task" },
      collection,
      signal: controller.signal,
    } as unknown as OpenArtifactCollection);
    return { controller, collection };
  };
  const connection = (value: boolean) => {
    online = value;
    for (const listener of listeners) listener();
  };
  return {
    add,
    confirmed: (event: RelayEvent) => confirmed([event]),
    connection,
  };
}
it("uses distinct collection and outbox locks, coalesces repair, and retires closed collections", async () => {
  const h = setup();
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(navigator.locks.request).toHaveBeenCalledTimes(2);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
  entry.controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
});
it("aborts reconciliation on disconnect and starts a new capture on reconnect", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactSnapshot).mockImplementationOnce(
    async (_reader, _collection, _type, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const signal = vi.mocked(reconcileArtifactSnapshot).mock.calls[0]?.[3];
  h.connection(false);
  expect(signal?.aborted).toBe(true);
  h.connection(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
});
it("commits proven local acceptance through the same revision path as live records", async () => {
  const h = setup();
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = signed(keypair(), {
    kind: 45010,
    content: "{}",
    tags: [
      ["d", "task"],
      ["h", "channel"],
      ["ar", "1"],
      ["type", "test.task"],
      ["op", "create"],
    ],
  });
  h.confirmed(eventDto(event));
  await vi.advanceTimersByTimeAsync(0);
  expect(entry.collection.applyBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      records: [
        expect.objectContaining({
          id: "task",
          revision: expect.objectContaining({ id: event.id }),
        }),
      ],
    }),
  );
});
