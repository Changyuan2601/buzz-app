import { afterEach, assert, expect, it, vi } from "vitest";
import {
  createOutbox,
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "./outbox";
import { MANAGED_RECEIPT_MS } from "./managed-delivery";
import { keypair, signed } from "./testing";
import type { RelayWriter } from "./transport";

const viewer = keypair();
const recipient = { channelId: "task-channel", agentId: "a".repeat(64) };
const input = {
  kind: 9,
  content: "Check the task",
  tags: [["h", recipient.channelId]],
};
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function memory() {
  let records: readonly OutgoingEvent[] = [];
  return {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
}
function setup(
  storage: OutboxStorage = memory(),
  publish: RelayWriter["publish"] = async () => {},
) {
  const sign = vi.fn(async (template) => signed(viewer, template));
  const writer = { sign, publish: vi.fn(publish) };
  const owner = createOutbox(viewer.pubkey, writer, storage);
  owners.push(owner);
  return { ...owner, ...writer, storage };
}
const ticks = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

it("saves managed intent before publication and only lets the sync owner publish", async () => {
  vi.useFakeTimers();
  const h = setup();
  const { operationId: id } = await h.delivery.submit(input, recipient);
  expect(h.publish).not.toHaveBeenCalled();
  expect(await h.storage.load()).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({ id }),
      managed: expect.objectContaining({ attempts: 0 }),
    }),
  ]);
  await h.managedOwner(true);
  await ticks();
  expect(h.publish).toHaveBeenCalledOnce();
  expect(await h.delivery.get(id)).toMatchObject({
    phase: "sending",
    relayAccepted: true,
    agentReceived: false,
  });
});
it("does not republish accepted work after restart or receipt retry", async () => {
  vi.useFakeTimers();
  const storage = memory();
  const first = setup(storage);
  const { operationId: id } = await first.delivery.submit(input, recipient);
  await first.managedOwner(true);
  await ticks();
  first.dispose();
  const next = setup(storage);
  await next.managedOwner(true);
  await ticks(MANAGED_RECEIPT_MS);
  expect(await next.delivery.get(id)).toMatchObject({
    phase: "failed",
    relayAccepted: true,
    error: "Could not confirm delivery",
  });
  await next.delivery.retry(id);
  await ticks();
  expect(next.publish).not.toHaveBeenCalled();
  expect(await next.delivery.get(id)).toMatchObject({
    phase: "sending",
    relayAccepted: true,
    agentReceived: false,
  });
});
it("retains exact signed event identity through lost confirmations and bounded retries", async () => {
  vi.useFakeTimers();
  const h = setup(memory(), async () => {
    throw new Error("Confirmation lost");
  });
  const { operationId: id } = await h.delivery.submit(input, recipient);
  await h.managedOwner(true);
  await ticks(8000);
  expect(h.publish).toHaveBeenCalledTimes(3);
  expect(h.sign).toHaveBeenCalledOnce();
  expect(new Set(h.publish.mock.calls.map(([event]) => event.id))).toEqual(
    new Set([id]),
  );
  expect(await h.delivery.get(id)).toMatchObject({
    phase: "failed",
    relayAccepted: false,
    error: "Could not send",
  });
});
it("transfers interrupted work to the next owner without a second signature", async () => {
  vi.useFakeTimers();
  const storage = memory();
  const first = setup(storage, async () => {
    throw new Error("Disconnected");
  });
  const { operationId: id } = await first.delivery.submit(input, recipient);
  await first.managedOwner(true);
  await ticks();
  await first.managedOwner(false);
  first.dispose();
  const next = setup(storage);
  await next.managedOwner(true);
  await ticks(1000);
  expect(next.publish).toHaveBeenCalledOnce();
  expect(next.publish.mock.calls[0]?.[0].id).toBe(id);
  expect(next.sign).not.toHaveBeenCalled();
});
it("waits for durable exact receipt and ignores other agents, channels and duplicate IDs", async () => {
  vi.useFakeTimers();
  const h = setup();
  const { operationId: id } = await h.delivery.submit(input, recipient);
  await h.managedOwner(true);
  await ticks();
  await h.receiveManaged("other", recipient.agentId, [id]);
  await h.receiveManaged(recipient.channelId, "b".repeat(64), [id]);
  expect(await h.delivery.get(id)).toMatchObject({ agentReceived: false });
  await h.receiveManaged(recipient.channelId, recipient.agentId, [id, id]);
  expect(await h.delivery.get(id)).toMatchObject({
    phase: "received",
    relayAccepted: true,
    agentReceived: true,
  });
  await ticks();
  await h.receiveManaged(recipient.channelId, recipient.agentId, [id]);
  expect(h.publish).toHaveBeenCalledOnce();
});
it("keeps accepted evidence when receipt persistence fails and accepts a late receipt", async () => {
  vi.useFakeTimers();
  const storage = memory();
  let fail = false;
  const h = setup({
    ...storage,
    save: async (records) => {
      if (fail) throw new Error("Disk full");
      storage.save(records);
    },
  });
  const { operationId: id } = await h.delivery.submit(input, recipient);
  await h.managedOwner(true);
  await ticks();
  fail = true;
  await expect(
    h.receiveManaged(recipient.channelId, recipient.agentId, [id]),
  ).rejects.toThrow("Disk full");
  expect(
    h.local.snapshot().find((item) => item.event.id === id)?.managed,
  ).toMatchObject({
    relayAccepted: true,
    agentReceived: false,
    error: "receipt-save",
  });
  fail = false;
  await ticks(MANAGED_RECEIPT_MS);
  await h.receiveManaged(recipient.channelId, recipient.agentId, [id]);
  expect(await h.delivery.get(id)).toMatchObject({
    phase: "received",
    agentReceived: true,
  });
  expect(h.publish).toHaveBeenCalledOnce();
});
it("does not retry a definitive refusal or publish after storage failure", async () => {
  vi.useFakeTimers();
  const h = setup(memory(), async () => {
    throw new PublishRejected("conflict: artifact head changed");
  });
  const { operationId: id } = await h.delivery.submit({
    kind: 45010,
    content: "Task",
    tags: [],
  });
  await h.managedOwner(true);
  await ticks(8000);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(await h.delivery.get(id)).toMatchObject({ phase: "failed" });
  const failed = setup({
    load: () => [],
    save: async () => {
      throw new Error("Disk full");
    },
  });
  await expect(failed.delivery.submit(input, recipient)).rejects.toThrow(
    "Disk full",
  );
  expect(failed.publish).not.toHaveBeenCalled();
});
it("records a batch receipt against each original message", async () => {
  vi.useFakeTimers();
  const h = setup();
  const one = await h.delivery.submit(input, recipient);
  const two = await h.delivery.submit(
    { ...input, content: "Second prompt" },
    recipient,
  );
  await h.managedOwner(true);
  await ticks();
  await h.receiveManaged(recipient.channelId, recipient.agentId, [
    one.eventId,
    two.eventId,
  ]);
  expect(await h.delivery.get(one.operationId)).toMatchObject({
    agentReceived: true,
  });
  expect(await h.delivery.get(two.operationId)).toMatchObject({
    agentReceived: true,
  });
});

it("keeps local intent added during a journal read until its save completes", async () => {
  vi.useFakeTimers();
  const storage = memory();
  let release: (() => void) | undefined;
  let reading = false;
  const h = setup({
    ...storage,
    load: async (options) => {
      const records = storage.load();
      if (options?.refresh && reading)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return records;
    },
  });
  await h.ready;
  reading = true;
  const refresh = h.delivery.get("missing");
  await ticks();
  const id = h.outbox.send(input, undefined, undefined, { recipient });
  reading = false;
  release?.();
  await refresh;
  await ticks();
  expect(await h.delivery.get(id)).toMatchObject({ phase: "sending" });
  expect(storage.load().some((item) => item.event.id === id)).toBe(true);
});
it("retains completed artifact delivery when its echo precedes the publish response", async () => {
  vi.useFakeTimers();
  let accept: (() => void) | undefined;
  const h = setup(
    memory(),
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  const { eventId: id } = await h.delivery.submit({
    kind: 45010,
    content: "{}",
    tags: [
      ["d", crypto.randomUUID()],
      ["h", recipient.channelId],
      ["type", "task"],
      ["op", "create"],
      ["ar", "1"],
    ],
  });
  await h.managedOwner(true);
  await ticks();
  const event = h.publish.mock.calls[0]?.[0];
  assert.exists(event);
  h.observe([event]);
  accept?.();
  await ticks();
  expect(await h.delivery.get(id)).toMatchObject({
    phase: "received",
    relayAccepted: true,
  });
  expect(
    h.local.snapshot().find((item) => item.event.id === id)?.managed
      ?.relayAccepted,
  ).toBe(true);
});
it("can retry and discard a definitive managed refusal", async () => {
  vi.useFakeTimers();
  const h = setup(memory(), async () => {
    throw new PublishRejected("artifact-head-conflict");
  });
  const { eventId: id } = await h.delivery.submit(input, recipient);
  await h.managedOwner(true);
  await ticks(1);
  expect(await h.delivery.get(id)).toMatchObject({ phase: "failed" });
  await h.delivery.retry(id);
  await ticks(1);
  expect(h.publish).toHaveBeenCalledTimes(2);
  await h.outbox.dismiss(id);
  expect(await h.delivery.get(id)).toBeUndefined();
});
it("cancels queued managed attempts before it releases ownership", async () => {
  vi.useFakeTimers();
  const h = setup(
    memory(),
    async (_event, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  for (let i = 0; i < 6; i++)
    await h.delivery.submit({ ...input, content: `Prompt ${i}` }, recipient);
  await h.managedOwner(true);
  await ticks();
  expect(h.publish).toHaveBeenCalledTimes(3);
  await h.managedOwner(false);
  await ticks(60_000);
  expect(h.publish).toHaveBeenCalledTimes(3);
});

it("publishes a delete with only its allowed artifact envelope and coalesces identical intent", async () => {
  vi.useFakeTimers();
  const allowed = new Set(["ar", "d", "h", "type", "op", "prev"]);
  const h = setup(memory(), async (event) => {
    if (event.tags.some(([key]) => !key || !allowed.has(key)))
      throw new PublishRejected(
        "delete allows only envelope and verified auth tags",
      );
  });
  const artifact = {
    kind: 45010,
    content: "",
    tags: [
      ["ar", "1"],
      ["d", crypto.randomUUID()],
      ["h", recipient.channelId],
      ["type", "test.task"],
      ["op", "delete"],
      ["prev", "b".repeat(64)],
    ],
  };
  const first = await h.delivery.submit(artifact);
  const second = await h.delivery.submit(artifact);
  expect(first).toEqual(second);
  expect(h.outbox.snapshot()).toHaveLength(1);
  await h.managedOwner(true);
  await ticks(1);
  expect(await h.delivery.get(first.operationId)).toMatchObject({
    phase: "received",
    relayAccepted: true,
  });
  expect(h.publish).toHaveBeenCalledOnce();
});

it("keeps the receipt deadline when a stale journal read races relay acceptance", async () => {
  vi.useFakeTimers();
  const storage = memory();
  let slow = false;
  let release: (() => void) | undefined;
  let accept: (() => void) | undefined;
  const h = setup(
    {
      ...storage,
      load: async (options) => {
        const records = storage.load();
        if (options?.refresh && slow)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return records;
      },
    },
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  const { eventId: id } = await h.delivery.submit(input, recipient);
  await h.managedOwner(true);
  await ticks();
  slow = true;
  const stale = h.delivery.get(id);
  await ticks();
  accept?.();
  await ticks();
  expect(
    h.local.snapshot().find((item) => item.event.id === id)?.managed
      ?.relayAccepted,
  ).toBe(true);
  slow = false;
  release?.();
  await stale;
  await ticks(1);
  expect(await h.delivery.get(id)).toMatchObject({
    phase: "sending",
    relayAccepted: true,
  });
  await ticks(MANAGED_RECEIPT_MS - 2);
  expect(await h.delivery.get(id)).toMatchObject({ phase: "sending" });
  await ticks(2);
  expect(await h.delivery.get(id)).toMatchObject({
    phase: "failed",
    error: "Could not confirm delivery",
  });
});

it("keeps a receipt error when a stale journal record has no error", async () => {
  vi.useFakeTimers();
  const storage = memory();
  const h = setup(storage);
  const { eventId: id } = await h.delivery.submit(input, recipient);
  await h.managedOwner(true);
  await ticks(1);
  const stale = storage.load();
  await ticks(MANAGED_RECEIPT_MS);
  expect(await h.delivery.get(id)).toMatchObject({ phase: "failed" });
  storage.save(stale);
  expect(await h.delivery.get(id)).toMatchObject({ phase: "failed" });
});
it("keeps retry backoff when a stale journal record has no attempt delay", async () => {
  vi.useFakeTimers();
  const storage = memory();
  const h = setup(storage, async () => {
    throw new Error("Confirmation lost");
  });
  const { eventId: id } = await h.delivery.submit(input, recipient);
  const stale = storage.load();
  await h.managedOwner(true);
  await ticks(1);
  expect(h.publish).toHaveBeenCalledOnce();
  storage.save(stale);
  await h.delivery.get(id);
  await ticks(1);
  expect(h.publish).toHaveBeenCalledOnce();
  await ticks(1000);
  expect(h.publish).toHaveBeenCalledTimes(2);
});
