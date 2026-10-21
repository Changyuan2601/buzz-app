import type { OpenArtifactCollection } from "../../src/features/artifact-storage/service";
import { provideArtifactSync } from "../../src/features/relay/artifact-sync";
import { createArtifactStore } from "../../src/features/artifact-storage/store";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { createOutbox } from "../../src/features/relay/outbox";
import { browserOutboxStorage } from "../../src/features/relay/outbox-storage";
import {
  mergeManagedDelivery,
  registerManagedDelivery,
} from "../../src/features/relay/managed-delivery";

const secret = new Uint8Array(32).fill(7);
const viewer = getPublicKey(secret);
const recipient = { channelId: "task", agentId: "a".repeat(64) };
const publications: string[] = [];
let owner: ReturnType<typeof createOutbox>;
let stopRegistration: (() => void) | undefined;
let ownership: Promise<void>;
let release: Promise<void>;
const open = async (scope: string) => {
  owner = createOutbox(
    viewer,
    {
      sign: async (template) =>
        finalizeEvent(structuredClone(template), secret),
      publish: async (event) => {
        publications.push(event.id);
      },
    },
    browserOutboxStorage(scope),
    { deliveryScope: scope },
  );
  await owner.ready;
  let acquired!: () => void;
  let released!: () => void;
  ownership = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  release = new Promise<void>((resolve) => {
    released = resolve;
  });
  stopRegistration = registerManagedDelivery(scope, {
    owner: async (owned) => {
      await owner.managedOwner(owned);
      if (owned) acquired();
      else released();
    },
    receive: owner.receiveManaged,
  });
};
const own = async (_scope: string) => {
  await ownership;
};
const captures: string[] = [];
async function openCollection(scope: string, name: string) {
  const relay = `https://${scope}.test`;
  const store = createArtifactStore(viewer, relay);
  const definition = {
    name,
    type: "test.delivery",
    version: 1,
    project: ({ record, preference }) => [
      { index: "pin", value: String(preference?.pinned), order: record.id },
    ],
  };
  const collection = store.collection("test.plugin", definition);
  await collection.importBatch({
    records: [{ id: "task", local: { title: "Saved" } }],
    preferences: [{ id: "task", value: { pinned: false } }],
    marker: "ready",
  });
  const signal = new AbortController();
  let opened: (entry: OpenArtifactCollection) => void = () => {};
  const session = {
    live: {
      snapshot: () => ({ status: "connected" }),
      subscribe: () => () => {},
    },
    channels: { list: () => ({ channels: [] }), subscribeList: () => () => {} },
    subscribeLive: () => () => {},
    subscribeArtifactUpdates: () => () => {},
    artifactSync: {
      delta: async () => {
        captures.push(name);
        return {
          startedAt: "2026-10-21T12:00:00.000001Z",
          overlapSeconds: 120,
          changes: [],
          nextCursor: null,
          checkpoint: crypto.randomUUID(),
        };
      },
      current: async (_query, artifactIds) => ({
        startedAt: "2026-10-21T12:00:00.000002Z",
        changes: artifactIds.map((artifactId) => ({
          type: "remove",
          artifactId,
        })),
      }),
    },
  };
  const effects = [];
  const ctx = {
    relay: {
      snapshot: () => ({
        viewer,
        origin: relay,
        status: "ready",
        cached: false,
        session,
      }),
      subscribe: () => () => {},
    },
    effect: (effect) => effects.push(effect()),
  };
  provideArtifactSync(ctx, {
    onOpen: (listener) => {
      opened = listener;
      return () => {};
    },
  });
  opened({
    viewer,
    relay,
    owner: "test.plugin",
    definition,
    collection,
    signal: signal.signal,
  });
  return () => collection.get("task");
}
let readCollection: Awaited<ReturnType<typeof openCollection>>;
Object.assign(window, {
  deliveryTest: {
    captures,
    openCollection: async (scope, name) => {
      readCollection = await openCollection(scope, name);
    },
    readCollection: () => readCollection(),
    open,
    own,
    publications,
    recipient,
    mergeManagedDelivery,
    storage: browserOutboxStorage,
    submit: () =>
      owner.delivery.submit(
        { kind: 9, content: "Task prompt", tags: [["h", "task"]] },
        recipient,
      ),
    debug: () =>
      owner.local.snapshot().map((item) => ({
        error: item.error,
        delivery: item.delivery,
        managed: item.managed,
      })),
    submitArtifact: () =>
      owner.delivery.submit(
        {
          kind: 45010,
          content: '{"title":"Pending"}',
          tags: [
            ["ar", "1"],
            ["d", "task"],
            ["h", "task"],
            ["type", "test.delivery"],
            ["op", "create"],
          ],
        },
        undefined,
        {
          operationKey: "setup/task",
          collection: { owner: "test.plugin", name: "main" },
        },
      ),
    artifact: () => owner.delivery.artifact("task"),
    captureArtifact: () =>
      owner.artifactDelivery.capture(
        "test.delivery",
        JSON.stringify(["test.plugin", "main"]),
      ),
    completeArtifact: (ids: string[]) =>
      owner.artifactDelivery.complete(ids, new AbortController().signal),
    get: (id: string) => owner.delivery.get(id),
    receive: (id: string) =>
      owner.receiveManaged(recipient.channelId, recipient.agentId, [id]),
    retry: (id: string) => owner.delivery.retry(id),
    release: async () => {
      stopRegistration?.();
      await release;
    },
  },
});
