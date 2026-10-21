import type { OpenArtifactCollection } from "../../src/features/artifact-storage/service";
import { provideArtifactSync } from "../../src/features/relay/artifact-sync";
import { createArtifactStore } from "../../src/features/artifact-storage/store";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { createOutbox } from "../../src/features/relay/outbox";
import { browserOutboxStorage } from "../../src/features/relay/outbox-storage";
import { mergeManagedDelivery } from "../../src/features/relay/managed-delivery";

const secret = new Uint8Array(32).fill(7);
const viewer = getPublicKey(secret);
const recipient = { channelId: "task", agentId: "a".repeat(64) };
const publications: string[] = [];
let owner: ReturnType<typeof createOutbox>;
let release: (() => void) | undefined;
let lock: Promise<void> | undefined;
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
  );
  await owner.ready;
};
const own = async (scope: string) => {
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  lock = navigator.locks.request(`delivery-check:${scope}`, async () => {
    await owner.managedOwner(true);
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await owner.managedOwner(false);
  });
  await ready;
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
    channels: { subscribeList: () => () => {} },
    subscribeLive: () => () => {},
    subscribeArtifactUpdates: () => () => {},
    artifactSnapshots: {
      start: async () => {
        captures.push(name);
        return {
          token: crypto.randomUUID(),
          expiresAt: Date.now() / 1000 + 300,
          entries: [],
          nextToken: null,
        };
      },
      complete: async () => {},
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
    get: (id: string) => owner.delivery.get(id),
    receive: (id: string) =>
      owner.receiveManaged(recipient.channelId, recipient.agentId, [id]),
    retry: (id: string) => owner.delivery.retry(id),
    release: async () => {
      release?.();
      await lock;
    },
  },
});
