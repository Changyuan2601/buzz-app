// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createOutbox, type OutgoingEvent } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { sendSnapshot } from "./snapshot-send";
import {
  recoverSnapshot,
  snapshotRecoveryKey,
  snapshotRecoveryValue,
} from "./snapshot-recovery";

it("accepts native agent and maximum-length team source IDs without aliasing recovery keys", () => {
  const nativeId = `${"a".repeat(64)}-${"b".repeat(64)}`;
  expect(nativeId).toHaveLength(129);
  expect(snapshotRecoveryKey("agent", nativeId)).toBe(
    `snapshot-share:agent:${nativeId}`,
  );
  const teamId = "t".repeat(128);
  expect(snapshotRecoveryKey("team", teamId)).toBe(
    `snapshot-share:team:${teamId}`,
  );
  expect(() => snapshotRecoveryKey("agent", "")).toThrow(
    "stable source identity",
  );
  expect(() => snapshotRecoveryKey("team", "x".repeat(130))).toThrow(
    "stable source identity",
  );
});

const key = snapshotRecoveryKey("agent", "worker-source");
const people = [{ pubkey: "b".repeat(64), name: "Receiver" }];
const recovery = { key, value: snapshotRecoveryValue(people, "none") };

it("restores the same receipt from the durable journal after outbox reload", async () => {
  const viewer = keypair();
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const publish = vi.fn<
    (event: RelayEvent, signal: AbortSignal) => Promise<void>
  >(async () => {
    throw new Error("Connection lost");
  });
  const writer = {
    sign: async (event: Parameters<typeof signed>[1]) => signed(viewer, event),
    publish,
  };
  const first = createOutbox(viewer.pubkey, writer, storage);
  const upload = vi.fn(async () => ({
    name: "worker.agent.png",
    url: "https://relay.example/file",
    type: "image/png",
    size: 1,
    sha256: "a".repeat(64),
  }));
  const encode = vi.fn(async () => ({
    fileBytes: [1],
    fileName: "worker.agent.png",
  }));
  const session = {
    directMessages: {
      available: true,
      open: async () => "conversation",
      delivery: () => "unknown",
      delivered: async () => {
        await vi.waitFor(() =>
          expect(records.some((item) => item.recovery?.key === key)).toBe(true),
        );
        throw new Error("Unknown receipt");
      },
    },
    attachments: { upload },
    messages: {
      send: (
        channelId: string,
        _content: string,
        _mentions: readonly string[],
        _attachments: unknown,
        saved: typeof recovery,
      ) =>
        first.outbox.send(
          { kind: 9, content: "snapshot link", tags: [["h", channelId]] },
          saved,
        ),
    },
  } as unknown as Pick<
    RelaySession,
    "directMessages" | "attachments" | "messages"
  >;
  let second: ReturnType<typeof createOutbox> | undefined;
  try {
    await first.outbox.ready();
    await expect(
      sendSnapshot({
        session,
        recipients: people.map((person) => person.pubkey),
        encode,
        recovery,
        signal: new AbortController().signal,
        update: () => {},
      }),
    ).rejects.toThrow("Unknown receipt");
    await vi.waitFor(() =>
      expect(first.outbox.snapshot()[0]?.delivery).toBe("unknown"),
    );
    const original = recoverSnapshot(first.outbox.snapshot(), key);
    first.dispose();
    publish.mockImplementation(async () => {});
    second = createOutbox(viewer.pubkey, writer, storage);
    await second.outbox.ready();
    const restored = recoverSnapshot(second.outbox.snapshot(), key);
    expect(restored).toEqual(original);
    if (!restored) throw new Error("Missing durable sharing receipt");
    Object.assign(session.directMessages, {
      delivered: async (id: string) => {
        second?.outbox.retry(id);
        await vi.waitFor(() =>
          expect(
            second?.outbox.snapshot().find((item) => item.event.id === id)
              ?.delivery,
          ).toBe("accepted"),
        );
      },
    });
    await sendSnapshot({
      session,
      recipients: restored.people.map((person) => person.pubkey),
      encode,
      recovery,
      receipt: restored.receipt,
      signal: new AbortController().signal,
      update: () => {},
    });
    expect(encode).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0].id).toBe(publish.mock.calls[0]?.[0].id);
    await second.outbox.acknowledge(restored.receipt.eventId);
    expect(recoverSnapshot(second.outbox.snapshot(), key)).toBeUndefined();
  } finally {
    first.dispose();
    second?.dispose();
  }
});

it("persists bounded intent metadata, never file or memory bytes", () => {
  expect(
    JSON.parse(
      snapshotRecoveryValue(
        [
          {
            pubkey: "b".repeat(64),
            name: "n".repeat(600),
            picture: "private extra metadata",
          },
        ],
        "core",
      ),
    ),
  ).toEqual({
    people: [{ pubkey: people[0]?.pubkey, name: "n".repeat(500) }],
    level: "core",
  });
});

it("fails closed on malformed or ambiguous recovery", () => {
  const event = {
    id: "receipt",
    kind: 9,
    content: "",
    pubkey: "f".repeat(64),
    created_at: 1,
    tags: [["h", "conversation"]],
  };
  const item = { event, recovery, delivery: "unknown" as const };
  expect(() => recoverSnapshot([item, item], key)).toThrow("Multiple");
  for (const value of [
    "null",
    "{}",
    "{",
    JSON.stringify({
      people: [{ pubkey: "invalid", name: "Receiver" }],
      level: "none",
    }),
    JSON.stringify({ people, level: "secret" }),
  ]) {
    expect(() =>
      recoverSnapshot([{ ...item, recovery: { key, value } }], key),
    ).toThrow();
  }
});
