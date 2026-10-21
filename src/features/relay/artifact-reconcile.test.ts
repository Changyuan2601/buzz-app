import { expect, it, vi } from "vitest";
import type { HostArtifactCollection } from "../artifact-storage/types";
import { reconcileArtifactSnapshot } from "./artifact-reconcile";
import {
  ArtifactSnapshotError,
  type ArtifactManifestPage,
  type ArtifactSnapshotReader,
} from "./artifact-snapshot";
import { keypair, signed } from "./testing";

const key = keypair();
const channelId = "11111111-1111-4111-8111-111111111111";
const event = (number: number) =>
  signed(key, {
    kind: 45010,
    content: `{"task":${number}}`,
    tags: [
      ["ar", "1"],
      ["d", `22222222-2222-4222-8222-${String(number).padStart(12, "0")}`],
      ["h", channelId],
      ["type", "test.task"],
      ["title", "Task"],
      ["op", "create"],
    ],
  });
function setup() {
  const events = [event(1), event(2), event(3)];
  const entries = events.map((item) => ({
    artifactId: item.tags.find(([name]) => name === "d")?.[1] as string,
    revisionId: item.id,
    channelId,
  }));
  const snapshot = {
    source: "source",
    generation: "generation",
  };
  const collection = {
    checkpoint: vi.fn(async () => "old"),
    setRefreshError: vi.fn(async () => {}),
    beginSnapshot: vi.fn(async (source: string) => ({ ...snapshot, source })),
    get: vi.fn(
      async (_id: string) =>
        undefined as Awaited<ReturnType<HostArtifactCollection["get"]>>,
    ),
    applyBatch: vi.fn(async () => {}),
    completeSnapshot: vi.fn(async () => {}),
  };
  const page = (
    start: number,
    end: number,
    nextToken: string | null,
  ): ArtifactManifestPage => ({
    token: "token",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    entries: entries.slice(start, end),
    nextToken,
  });
  const reader = {
    start: vi.fn(async () => page(0, 2, "next")),
    page: vi.fn(async () => page(2, 3, null)),
    bodies: vi.fn<ArtifactSnapshotReader["bodies"]>(async (_token, wanted) =>
      events.filter((item) =>
        wanted.some((entry) => entry.revisionId === item.id),
      ),
    ),
    complete: vi.fn(async () => {}),
  };
  const controller = new AbortController();
  const run = () =>
    reconcileArtifactSnapshot(
      reader,
      collection as unknown as HostArtifactCollection,
      "test.task",
      controller.signal,
    );
  return { events, entries, collection, reader, controller, run };
}
it("commits each page before validated completion and advances the captured checkpoint", async () => {
  const h = setup();
  await h.run();
  expect(h.reader.bodies).toHaveBeenCalledTimes(2);
  expect(h.reader.page).toHaveBeenCalledWith(
    "token",
    "next",
    h.controller.signal,
  );
  expect(h.collection.applyBatch.mock.invocationCallOrder[1]).toBeLessThan(
    h.reader.complete.mock.invocationCallOrder[0] as number,
  );
  expect(h.reader.complete.mock.invocationCallOrder[0]).toBeLessThan(
    h.collection.completeSnapshot.mock.invocationCallOrder[0] as number,
  );
  expect(h.collection.completeSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ generation: "generation" }),
    { expected: "old", next: "token" },
    h.controller.signal,
  );
});
it("reuses a verified cached body and marks its captured revision seen", async () => {
  const h = setup();
  const first = h.events[0];
  h.collection.get.mockImplementation(async (id) =>
    id === h.entries[0]?.artifactId && first
      ? {
          record: {
            id,
            availability: { state: "available" },
            current: {
              id: first.id,
              content: first.content,
              event: first,
            },
          },
        }
      : undefined,
  );
  await h.run();
  expect(h.reader.bodies.mock.calls[0]?.[1]).toEqual([h.entries[1]]);
  expect(h.collection.applyBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      seen: [{ id: h.entries[0]?.artifactId, revisionId: first?.id }],
    }),
    h.controller.signal,
  );
});
it("keeps received pages after an interrupted read without reconciling absence", async () => {
  const h = setup();
  h.reader.page.mockRejectedValue(new Error("Disconnected"));
  await expect(h.run()).rejects.toThrow("Disconnected");
  expect(h.collection.applyBatch).toHaveBeenCalledOnce();
  expect(h.collection.completeSnapshot).not.toHaveBeenCalled();
});
it.each(["snapshot_reset", "snapshot_limit"] as const)(
  "does not reconcile absence after server %s",
  async (code) => {
    const h = setup();
    h.reader.complete.mockRejectedValue(
      new ArtifactSnapshotError(code, "Snapshot invalid"),
    );
    await expect(h.run()).rejects.toMatchObject({ code });
    expect(h.collection.completeSnapshot).not.toHaveBeenCalled();
  },
);

it("rejects local completion when the live interval is lost after server completion", async () => {
  const h = setup();
  h.reader.complete.mockImplementation(async () => {
    h.controller.abort();
  });
  await expect(h.run()).rejects.toMatchObject({ name: "AbortError" });
  expect(h.collection.completeSnapshot).not.toHaveBeenCalled();
});
it("rejects repeated identities across pages", async () => {
  const h = setup();
  h.reader.page.mockImplementation(async () => ({
    ...(await h.reader.start()),
    nextToken: null,
  }));
  await expect(h.run()).rejects.toThrow("repeats");
  expect(h.collection.completeSnapshot).not.toHaveBeenCalled();
});
it("reduces a body batch on a byte limit and rejects an unsatisfiable single body", async () => {
  const h = setup();
  h.reader.bodies.mockImplementation(async (_token, wanted) => {
    if (wanted.length > 1)
      throw new ArtifactSnapshotError("snapshot_limit", "Body batch too large");
    return h.events.filter((item) =>
      wanted.some((entry) => entry.revisionId === item.id),
    );
  });
  await h.run();
  expect(h.reader.bodies).toHaveBeenCalledTimes(4);
  h.reader.bodies.mockRejectedValue(
    new ArtifactSnapshotError("snapshot_limit", "Body too large"),
  );
  h.collection.completeSnapshot.mockClear();
  await expect(h.run()).rejects.toMatchObject({ code: "snapshot_limit" });
  expect(h.collection.completeSnapshot).not.toHaveBeenCalled();
});

it("saves an admission error without changing records or establishing absence", async () => {
  const h = setup();
  h.reader.start.mockRejectedValue(
    new ArtifactSnapshotError("snapshot_limit", "Too many memberships"),
  );
  await expect(h.run()).rejects.toMatchObject({ code: "snapshot_limit" });
  expect(h.collection.applyBatch).not.toHaveBeenCalled();
  expect(h.collection.completeSnapshot).not.toHaveBeenCalled();
  expect(h.collection.setRefreshError).toHaveBeenCalledWith(
    expect.objectContaining({ generation: "generation" }),
    "The relay limit prevents a refresh of saved data",
    h.controller.signal,
  );
});
