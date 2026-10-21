import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../artifact-storage/service";
import { provideArtifactSync } from "./artifact-sync";
import { ArtifactSyncError } from "./artifact-reader";
import { registerArtifactDelivery } from "./artifact-delivery";
import {
  reconcileArtifactDelta,
  reconcileArtifactCurrent,
} from "./artifact-reconcile";
import { keypair, signed } from "./testing";
import { eventDto, type RelayEvent } from "./events";
vi.mock("./artifact-reconcile", async (original) => ({
  ...(await original<typeof import("./artifact-reconcile")>()),
  reconcileArtifactDelta: vi.fn(async () => {}),
  reconcileArtifactCurrent: vi.fn(async () => {}),
}));
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllMocks();
  vi.mocked(reconcileArtifactDelta).mockReset().mockResolvedValue(undefined);
  vi.mocked(reconcileArtifactCurrent).mockReset().mockResolvedValue(undefined);
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
    artifactSync: {},
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
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
  entry.controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});
it("aborts reconciliation on disconnect and starts a new capture on reconnect", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(
    async (_reader, _collection, _type, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const signal = vi.mocked(reconcileArtifactDelta).mock.calls[0]?.[3];
  h.connection(false);
  expect(signal?.aborted).toBe(true);
  h.connection(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
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
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
});

it("ignores channel activity but repairs when roster membership changes", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  h.roster([{ id: "one", lastActivityAt: 10 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  h.roster([
    { id: "one", lastActivityAt: 10 },
    { id: "two", lastActivityAt: 0 },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});
it("releases an expired version so a current collection can own sync", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockRejectedValueOnce(
    new Error("Artifact collection version changed"),
  );
  const old = h.add();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
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
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(async () => {
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
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  for (let i = 0; i < 50; i++) h.confirmed(event);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  expect(entry.collection.applyBatch).not.toHaveBeenCalled();
});

it("keeps capture admission failures on the repair interval despite live traffic", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockRejectedValue(
    new ArtifactSyncError("sync_limit", "Too many memberships"),
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  for (let i = 0; i < 20; i++) {
    h.confirmed(event);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});
it("keeps a current handle when an older in-flight version fails", async () => {
  const h = setup();
  let fail = () => {};
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(async () => {
    await new Promise<void>((_resolve, reject) => {
      fail = () => reject(new Error("Artifact collection version changed"));
    });
  });
  const old = h.add(1);
  await vi.advanceTimersByTimeAsync(0);
  const current = h.add(2);
  fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
  expect(vi.mocked(reconcileArtifactDelta).mock.calls[1]?.[1]).toBe(
    current.collection,
  );
  old.controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(3);
  expect(navigator.locks.request).toHaveBeenCalledOnce();
});
it("confirms only frozen accepted operations after a current read starts and commits", async () => {
  const h = setup();
  let pending = true;
  const capture = vi.fn(async () => (pending ? ["accepted-operation"] : []));
  const targets = vi.fn(() =>
    pending ? [{ operationId: "accepted-operation", artifactId: "task" }] : [],
  );
  const complete = vi.fn(async () => {
    pending = false;
  });
  registerArtifactDelivery(h.session, { capture, targets, complete });
  let finish = () => {};
  vi.mocked(reconcileArtifactCurrent).mockImplementationOnce(async () => {
    expect(capture).toHaveBeenCalledWith(
      "test.task",
      JSON.stringify(["test.plugin", "tasks"]),
    );
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).not.toHaveBeenCalled();
  expect(reconcileArtifactDelta).not.toHaveBeenCalled();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).toHaveBeenCalledWith(
    ["accepted-operation"],
    expect.any(AbortSignal),
  );
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
});
it("does not attach acceptance during a delta to that in-flight response", async () => {
  const h = setup();
  let pending = false;
  const complete = vi.fn(async () => {
    pending = false;
  });
  registerArtifactDelivery(h.session, {
    capture: async () => (pending ? ["operation"] : []),
    targets: () =>
      pending ? [{ operationId: "operation", artifactId: "task" }] : [],
    complete,
  });
  let finish = () => {};
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  pending = true;
  h.confirmed(
    eventDto(
      signed(keypair(), {
        kind: 45010,
        content: "{}",
        tags: [
          ["type", "test.task"],
          ["d", "task"],
        ],
      }),
    ),
  );
  expect(reconcileArtifactCurrent).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledWith(["operation"], expect.any(AbortSignal));
});
it("retains an accepted obligation after a failed current read", async () => {
  const h = setup();
  let pending = true;
  const complete = vi.fn(async () => {
    pending = false;
  });
  registerArtifactDelivery(h.session, {
    capture: async () => (pending ? ["operation"] : []),
    targets: () =>
      pending ? [{ operationId: "operation", artifactId: "task" }] : [],
    complete,
  });
  vi.mocked(reconcileArtifactCurrent).mockRejectedValueOnce(
    new Error("Disconnected"),
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(complete).toHaveBeenCalledWith(["operation"], expect.any(AbortSignal));
});
it("keeps duplicate delayed hints behind an in-flight current read", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  let finish = () => {};
  vi.mocked(reconcileArtifactCurrent).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  h.confirmed(event);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 50; i++) h.confirmed(event);
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(2);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
});
it("uses bounded current reads and requests a delta after live overflow", async () => {
  const h = setup();
  let finish = () => {};
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const key = keypair();
  for (let i = 0; i < 1002; i++)
    h.confirmed(
      eventDto(
        signed(key, {
          kind: 45010,
          content: "{}",
          tags: [
            ["type", "test.task"],
            ["d", `task-${i}`],
          ],
        }),
      ),
    );
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(10);
  expect(
    vi
      .mocked(reconcileArtifactCurrent)
      .mock.calls.every((call) => call[3].length <= 100),
  ).toBe(true);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});
