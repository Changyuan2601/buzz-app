import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../artifact-storage/service";
import { provideArtifactSync } from "./artifact-sync";
import { ArtifactSnapshotError } from "./artifact-snapshot";
import { registerArtifactDelivery } from "./artifact-delivery";
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
  let rosterListener = () => {};
  let channels = [{ id: "one", lastActivityAt: 0 }];
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
    channels: {
      list: () => ({ channels }),
      subscribeList: (listener: () => void) => {
        rosterListener = listener;
        return () => {};
      },
    },
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
  const add = (version = 1) => {
    const controller = new AbortController();
    const collection = { applyBatch: vi.fn(async () => {}) };
    opened({
      viewer: "viewer",
      relay: "https://relay.test",
      owner: "test.plugin",
      definition: { name: "tasks", type: "test.task", version },
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
    session,
    add,
    confirmed: (event: RelayEvent) => confirmed([event]),
    connection,
    roster: (value: typeof channels) => {
      channels = value;
      rosterListener();
    },
  };
}
it("coalesces collection repair and retires closed collections", async () => {
  const h = setup();
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(navigator.locks.request).toHaveBeenCalledTimes(1);
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
it("refreshes after proven acceptance without writing raw revisions", async () => {
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
  expect(entry.collection.applyBatch).not.toHaveBeenCalled();
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
});

it("ignores channel activity but repairs when roster membership changes", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  h.roster([{ id: "one", lastActivityAt: 10 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledOnce();
  h.roster([
    { id: "one", lastActivityAt: 10 },
    { id: "two", lastActivityAt: 0 },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
});
it("releases an expired version so a current collection can own sync", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactSnapshot).mockRejectedValueOnce(
    new Error("Artifact collection version changed"),
  );
  const old = h.add();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledOnce();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  old.controller.abort();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(navigator.locks.request).toHaveBeenCalledTimes(2);
});

it("coalesces live invalidations during a capture into one later refresh", async () => {
  const h = setup();
  let release = () => {};
  vi.mocked(reconcileArtifactSnapshot).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [["type", "test.task"]],
    }),
  );
  for (let i = 0; i < 50; i++) h.confirmed(event);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
  expect(entry.collection.applyBatch).not.toHaveBeenCalled();
});

it("keeps capture admission failures on the repair interval despite live traffic", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactSnapshot).mockRejectedValue(
    new ArtifactSnapshotError("snapshot_limit", "Too many memberships"),
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [["type", "test.task"]],
    }),
  );
  for (let i = 0; i < 20; i++) {
    h.confirmed(event);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(reconcileArtifactSnapshot).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
});
it("captures accepted delivery before starting a snapshot and confirms only after completion", async () => {
  const h = setup();
  const capture = vi.fn(async () => ["accepted-before-start"]);
  const complete = vi.fn(async () => {});
  registerArtifactDelivery(h.session, { capture, complete });
  let finish = () => {};
  vi.mocked(reconcileArtifactSnapshot).mockImplementationOnce(
    async (_reader, _collection, _type, _signal, options) => {
      expect(capture).toHaveBeenCalledWith(
        "test.task",
        JSON.stringify(["test.plugin", "tasks"]),
      );
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await options?.onComplete?.();
    },
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).not.toHaveBeenCalled();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).toHaveBeenCalledWith(
    ["accepted-before-start"],
    expect.any(AbortSignal),
  );
});

it("keeps a current handle when an older in-flight version fails", async () => {
  const h = setup();
  let fail = () => {};
  vi.mocked(reconcileArtifactSnapshot).mockImplementationOnce(async () => {
    await new Promise<void>((_resolve, reject) => {
      fail = () => reject(new Error("Artifact collection version changed"));
    });
  });
  const old = h.add(1);
  await vi.advanceTimersByTimeAsync(0);
  const current = h.add(2);
  fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(2);
  expect(vi.mocked(reconcileArtifactSnapshot).mock.calls[1]?.[1]).toBe(
    current.collection,
  );
  old.controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactSnapshot).toHaveBeenCalledTimes(3);
  expect(navigator.locks.request).toHaveBeenCalledOnce();
});
