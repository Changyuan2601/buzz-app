import { expect, it, vi } from "vitest";
import type {
  ArtifactEntry,
  HostArtifactCollection,
} from "../artifact-storage/types";
import {
  reconcileArtifactDelta,
  reconcileArtifactCurrent,
} from "./artifact-reconcile";
import { ArtifactSyncError, type ArtifactSyncReader } from "./artifact-reader";
import { keypair, signed } from "./testing";
import { eventDto } from "./events";
const channel = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const event = eventDto(
  signed(keypair(), {
    kind: 45010,
    content: "{}",
    tags: [
      ["ar", "1"],
      ["d", id],
      ["h", channel],
      ["type", "test.task"],
      ["op", "create"],
    ],
  }),
);
const old = JSON.stringify({ protocol: "sync-v1", checkpoint: "old" });
function setup(checkpoint: string | null = old) {
  const rows = new Map<string, ArtifactEntry>();
  const controller = new AbortController();
  const collection = {
    checkpoint: vi.fn(async () => checkpoint),
    beginRefresh: vi.fn(async (source: string) => ({
      source,
      generation: "generation",
    })),
    setRefreshError: vi.fn(async () => {}),
    get: vi.fn(async (id: string) => rows.get(id)),
    knownIds: vi.fn(async ({ channelId }: { channelId?: string }) => ({
      ids: [...rows]
        .filter(([, row]) => !channelId || row.record.channelId === channelId)
        .map(([key]) => key),
    })),
    applyBatch: vi.fn<HostArtifactCollection["applyBatch"]>(async (batch) => {
      for (const item of batch.records ?? [])
        rows.set(item.id, {
          record: {
            id: item.id,
            channelId: item.channelId,
            current: item.revision,
            availability: { state: "unknown" },
          },
        });
      for (const item of batch.availability ?? []) {
        const row = rows.get(item.id);
        if ((row?.record.current?.id ?? null) !== item.expectedRevision)
          throw new Error("Artifact revision changed");
        if (row)
          rows.set(item.id, {
            ...row,
            record: { ...row.record, availability: item.value },
          });
      }
    }),
    completeRefresh: vi.fn(async () => {}),
  };
  const page = {
    version: 1 as const,
    startedAt: "2026-10-21T12:00:00.000001Z",
    overlapSeconds: 120 as const,
    changes: [],
    nextCursor: null,
    checkpoint: "next",
  };
  const reader = {
    delta: vi.fn<ArtifactSyncReader["delta"]>(async () => page),
    current: vi.fn<ArtifactSyncReader["current"]>(async (_query, ids) => ({
      version: 1,
      startedAt: page.startedAt,
      changes: ids.map((artifactId) => ({ type: "remove", artifactId })),
    })),
  };
  const host = collection as unknown as HostArtifactCollection;
  return {
    rows,
    collection,
    reader,
    page,
    controller,
    delta: () =>
      reconcileArtifactDelta(reader, host, "test.task", controller.signal),
    current: (ids: string[]) =>
      reconcileArtifactCurrent(
        reader,
        host,
        "test.task",
        ids,
        controller.signal,
      ),
  };
}
it("saves delta progress only after all pages commit", async () => {
  const h = setup();
  h.reader.delta.mockResolvedValueOnce({
    ...h.page,
    changes: [{ type: "upsert", artifactId: id, event }],
    nextCursor: "second",
    checkpoint: null,
  });
  await h.delta();
  expect(h.reader.delta.mock.calls[1]?.[1]).toEqual({
    checkpoint: "old",
    cursor: "second",
  });
  expect(h.collection.applyBatch.mock.invocationCallOrder[0]).toBeLessThan(
    h.collection.completeRefresh.mock.invocationCallOrder[0] as number,
  );
  expect(h.collection.completeRefresh).toHaveBeenCalledWith(
    expect.objectContaining({ generation: "generation" }),
    {
      expected: old,
      next: JSON.stringify({ protocol: "sync-v1", checkpoint: "next" }),
    },
    h.controller.signal,
  );
});
it("does not infer absence from an empty delta", async () => {
  const h = setup();
  h.rows.set(id, {
    record: {
      id,
      current: { id: "older", content: "saved" },
      availability: { state: "available" },
    },
  });
  await h.delta();
  expect(h.rows.get(id)?.record.availability.state).toBe("available");
  expect(h.reader.current).not.toHaveBeenCalled();
  expect(h.collection.knownIds).not.toHaveBeenCalled();
});
it("removes a locally observed revision after missed intermediate changes", async () => {
  const h = setup();
  h.rows.set(id, {
    record: {
      id,
      current: { id: "locally-observed", content: "saved" },
      availability: { state: "available" },
    },
    preference: { pinned: false },
  });
  h.reader.delta.mockResolvedValue({
    ...h.page,
    changes: [{ type: "remove", artifactId: id }],
  });
  await h.delta();
  expect(h.collection.applyBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      availability: [
        {
          id,
          expectedRevision: "locally-observed",
          value: { state: "unavailable" },
        },
      ],
    }),
    h.controller.signal,
  );
  expect(h.rows.get(id)).toMatchObject({
    preference: { pinned: false },
    record: {
      current: { content: "saved" },
      availability: { state: "unavailable" },
    },
  });
});
it.each(["page", "commit"])(
  "keeps progress after a failed %s",
  async (failure) => {
    const h = setup();
    h.reader.delta.mockResolvedValueOnce({
      ...h.page,
      changes: [{ type: "upsert", artifactId: id, event }],
      nextCursor: "second",
      checkpoint: null,
    });
    if (failure === "page")
      h.reader.delta.mockRejectedValueOnce(new Error("Disconnected"));
    else
      h.collection.applyBatch.mockRejectedValueOnce(
        new Error("Artifact revision changed"),
      );
    await expect(h.delta()).rejects.toThrow();
    expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  },
);
it.each(["policy_changed", "checkpoint_expired"])(
  "recovers %s with bootstrap and known-ID reads before progress",
  async (reason) => {
    const h = setup();
    h.rows.set("imported", {
      record: {
        id: "imported",
        local: { title: "Local" },
        availability: { state: "unknown" },
      },
    });
    h.reader.delta.mockRejectedValueOnce(
      new ArtifactSyncError(
        "sync_reset",
        "Reset",
        reason as "policy_changed" | "checkpoint_expired",
      ),
    );
    await h.delta();
    expect(h.reader.delta.mock.calls[1]?.[1]).toEqual({
      checkpoint: undefined,
      cursor: undefined,
    });
    expect(h.reader.current.mock.calls[0]?.[1]).toEqual(["imported"]);
    expect(h.reader.current.mock.invocationCallOrder[0]).toBeLessThan(
      h.collection.completeRefresh.mock.invocationCallOrder[0] as number,
    );
    expect(h.rows.get("imported")?.record.availability.state).toBe(
      "unavailable",
    );
  },
);
it("keeps recovery incomplete after failed revalidation", async () => {
  const h = setup(null);
  h.rows.set(id, { record: { id, availability: { state: "available" } } });
  h.reader.current.mockRejectedValue(new Error("Disconnected"));
  await expect(h.delta()).rejects.toThrow("Disconnected");
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  expect(h.rows.get(id)?.record.availability.state).toBe("available");
});
it("revalidates saved IDs on the first pass and migrates an old checkpoint", async () => {
  const h = setup("old-snapshot-token");
  h.rows.set(id, { record: { id, availability: { state: "unknown" } } });
  await h.delta();
  expect(h.reader.delta.mock.calls[0]?.[1].checkpoint).toBeUndefined();
  expect(h.reader.current).toHaveBeenCalledOnce();
});
it("keeps a moved artifact when the old channel is removed later", async () => {
  const h = setup();
  const oldChannel = "33333333-3333-4333-8333-333333333333";
  h.rows.set(id, {
    record: { id, channelId: oldChannel, availability: { state: "available" } },
  });
  h.reader.delta.mockResolvedValue({
    ...h.page,
    changes: [
      { type: "upsert", artifactId: id, event },
      { type: "removeChannel", channelId: oldChannel },
    ],
  });
  await h.delta();
  expect(h.rows.get(id)?.record).toMatchObject({
    channelId: channel,
    availability: { state: "available" },
  });
});
it("restores an upsert after removal of its old channel", async () => {
  const h = setup();
  h.rows.set(id, {
    record: { id, channelId: channel, availability: { state: "available" } },
  });
  h.reader.delta.mockResolvedValue({
    ...h.page,
    changes: [
      { type: "removeChannel", channelId: channel },
      { type: "upsert", artifactId: id, event },
    ],
  });
  await h.delta();
  expect(h.rows.get(id)?.record.availability.state).toBe("available");
});
it("does not advance delta progress or clear its error on a current read", async () => {
  const h = setup();
  await h.current([id]);
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
  expect(h.collection.checkpoint).not.toHaveBeenCalled();
});
it("splits a current batch on capacity and rejects an oversized single result", async () => {
  const h = setup();
  h.reader.current.mockImplementation(async (_query, ids) => {
    if (ids.length > 1) throw new ArtifactSyncError("sync_limit", "Large");
    return {
      version: 1,
      startedAt: h.page.startedAt,
      changes: [{ type: "remove", artifactId: ids[0] as string }],
    };
  });
  await h.current([id, "imported"]);
  expect(h.reader.current).toHaveBeenCalledTimes(3);
  h.reader.current.mockRejectedValue(
    new ArtifactSyncError("sync_limit", "Large"),
  );
  await expect(h.current([id])).rejects.toMatchObject({ code: "sync_limit" });
});
it("rejects repeated cursors and changed capture times", async () => {
  const h = setup();
  h.reader.delta.mockResolvedValue({
    ...h.page,
    nextCursor: "same",
    checkpoint: null,
  });
  await expect(h.delta()).rejects.toThrow("cursor repeats");
  h.reader.delta
    .mockReset()
    .mockResolvedValueOnce({
      ...h.page,
      nextCursor: "second",
      checkpoint: null,
    })
    .mockResolvedValue({ ...h.page, startedAt: "2026-10-21T12:00:01.000001Z" });
  await expect(h.delta()).rejects.toThrow("capture changes");
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
});
it("cancels before a late local completion", async () => {
  const h = setup();
  h.reader.delta.mockImplementation(async () => {
    h.controller.abort();
    return h.page;
  });
  await expect(h.delta()).rejects.toMatchObject({ name: "AbortError" });
  expect(h.collection.completeRefresh).not.toHaveBeenCalled();
});
