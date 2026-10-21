import { assert, expect, it } from "vitest";
import { createThreadView } from "./threads";
import type { OutgoingEvent } from "./outbox";
import { keypair, message } from "./testing";

it("projects exact receipt changes into an existing thread row", async () => {
  const key = keypair();
  const root = message(key, "channel", "Managed prompt", 1);
  let operations: readonly OutgoingEvent[] = [
    {
      event: root,
      signed: root,
      delivery: "accepted",
      managed: {
        version: 1,
        recipient: { channelId: "channel", agentId: key.pubkey },
        round: 0,
        attempts: 1,
        relayAccepted: true,
        agentReceived: false,
        nextAttemptAt: 0,
        receiptDeadline: 30000,
      },
    },
  ];
  const listeners = new Set<() => void>();
  const owned = createThreadView({
    channelId: "channel",
    messageId: root.id,
    relayAuthor: key.pubkey,
    seed: root,
    reader: { read: async () => [root] },
    local: {
      snapshot: () => operations,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    canAccess: () => true,
    visible: (events) => events,
    notify: (listener) => listener(),
  });
  const view = owned.view;
  try {
    await view.refresh();
    const before = view.snapshot().root;
    expect(before?.managedDelivery).toMatchObject({
      phase: "sending",
      relayAccepted: true,
      agentReceived: false,
    });
    owned.changed();
    expect(view.snapshot().root).toBe(before);
    operations = operations.map((item) => {
      assert.exists(item.managed);
      return {
        ...item,
        managed: { ...item.managed, error: "receipt" as const },
      };
    });
    owned.changed();
    expect(view.snapshot().root?.managedDelivery).toMatchObject({
      phase: "failed",
      error: "Could not confirm delivery",
    });
    operations = operations.map((item) => {
      assert.exists(item.managed);
      return { ...item, managed: { ...item.managed, agentReceived: true } };
    });
    owned.changed();
    expect(view.snapshot().root).not.toBe(before);
    expect(view.snapshot().root?.managedDelivery).toMatchObject({
      phase: "received",
      agentReceived: true,
    });
  } finally {
    view.dispose();
  }
});
