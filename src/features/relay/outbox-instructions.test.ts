import { assert, afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { createRelaySession } from "./session";
import type { OutboxStorage, OutgoingEvent } from "./outbox";
import type { RelayEvent } from "./events";
import { flush, keypair, scriptedTransport, signed } from "./testing";
import {
  INSTRUCTIONS_CONTENT_MAX_BYTES,
  INSTRUCTIONS_KIND,
} from "../agents/instructions-envelope";
import deletionContract from "../agents/instructions-deletion-contract.json";

const viewer = keypair(),
  relay = keypair();
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const T0 = 1_800_000_000;
const agent = (n: number) => n.toString(16).padStart(64, "0");
const version = (subject: string, content = "x") => ({
  kind: INSTRUCTIONS_KIND,
  content,
  tags: [["p", subject]],
});
const maxSize = (subject: string) =>
  version(subject, "x".repeat(INSTRUCTIONS_CONTENT_MAX_BYTES));

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});
function setup() {
  let records: readonly OutgoingEvent[] = [];
  const saved: number[] = [];
  const storage: OutboxStorage = {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
      saved.push(JSON.stringify(next).length);
    },
  };
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const signatures: { event: EventTemplate; resolve(e: RelayEvent): void }[] =
    [];
  const published: RelayEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: (event: EventTemplate) =>
          new Promise<RelayEvent>((resolve) =>
            signatures.push({ event, resolve }),
          ),
        publish: async (event: RelayEvent) => {
          published.push(event);
        },
      },
    },
    { outboxStorage: storage },
  );
  owners.push(owner);
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const signAll = async () => {
    await flush();
    for (const request of signatures.splice(0))
      request.resolve(signed(viewer, request.event));
    await flush();
  };
  return {
    outbox,
    signatures,
    published,
    saved,
    signAll,
    records: () => records,
  };
}

it("T9 a max-size version goes through the outbox and signer; an ordinary 33 KiB message is still refused", async () => {
  const h = setup();
  await h.outbox.ready();
  const id = h.outbox.send(maxSize(agent(1)));
  await h.signAll();
  expect(h.published.map((event) => event.id)).toEqual([id]);
  expect(h.published[0]?.content).toHaveLength(INSTRUCTIONS_CONTENT_MAX_BYTES);
  expect(() =>
    h.outbox.send({
      kind: 9,
      content: "x".repeat(33 * 1024),
      tags: [["h", "c"]],
    }),
  ).toThrow("too large");
  expect(() =>
    h.outbox.send(
      version(agent(2), "x".repeat(INSTRUCTIONS_CONTENT_MAX_BYTES + 1)),
    ),
  ).toThrow("too large");
});

it("T10 created_at is head + 1 when the clock is behind; more than 60 s ahead is refused", async () => {
  const h = setup();
  await h.outbox.ready();
  vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
  const id = h.outbox.send({ ...version(agent(1)), supersedes: T0 + 30 });
  expect(
    h.outbox.snapshot().find((item) => item.event.id === id)?.event.created_at,
  ).toBe(T0 + 31);
  const before = h.outbox.snapshot();
  expect(() =>
    h.outbox.send({ ...version(agent(2)), supersedes: T0 + 60 }),
  ).toThrow("clock changed");
  expect(h.outbox.snapshot()).toBe(before);
  const now = h.outbox.send(version(agent(3)));
  expect(
    h.outbox.snapshot().find((item) => item.event.id === now)?.event.created_at,
  ).toBe(T0);
});

it("T29 admits max-size saves only while their projected signed sizes fit, then persists them all under 2 MiB", async () => {
  const h = setup();
  await h.outbox.ready();
  const admitted: string[] = [];
  let refused: unknown;
  for (let n = 1; n < 20 && !refused; n++)
    try {
      admitted.push(h.outbox.send(maxSize(agent(n))));
    } catch (error) {
      refused = error;
    }
  expect(admitted.length).toBeGreaterThan(1);
  expect(String(refused)).toContain("Too many unsent instruction changes");
  // Refused before persistence: nothing of it was journaled.
  expect(h.outbox.snapshot()).toHaveLength(admitted.length);
  // Ordinary messages still fit beside them.
  h.outbox.send({ kind: 9, content: "hello", tags: [["h", "c"]] });
  // Every signature lands: each entry persists, still under the journal limit.
  await h.signAll();
  expect(
    h
      .records()
      .filter((item) => item.event.kind === INSTRUCTIONS_KIND && item.signed),
  ).toHaveLength(admitted.length);
  expect(Math.max(...h.saved)).toBeLessThan(JOURNAL_MAX_BYTES);
  // Signed entries are counted once, at their real size: the next is still refused.
  expect(() => h.outbox.send(maxSize(agent(50)))).toThrow("Too many unsent");
  // Retiring one releases its reservation.
  await h.outbox.retire(admitted[0] as string);
  expect(() => h.outbox.send(maxSize(agent(51)))).not.toThrow();
});

it("T29 a hydrated unsigned entry is reserved before new admissions", async () => {
  const first = setup();
  await first.outbox.ready();
  const admitted: string[] = [];
  try {
    for (let n = 1; n < 20; n++)
      admitted.push(first.outbox.send(maxSize(agent(n))));
  } catch {}
  await flush();
  const journal = first.records();
  expect(journal.every((item) => !item.signed)).toBe(true);
  // A restart: the same journal, signer not yet answered.
  let records = journal;
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: () => new Promise(() => {}), publish: async () => {} },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = next;
        },
      },
    },
  );
  owners.push(owner);
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  await outbox.ready();
  expect(() => outbox.send(maxSize(agent(60)))).toThrow("Too many unsent");
});

it("a version deletion leaves the outbox in the exact shape the native instructions signer admits", async () => {
  const h = setup();
  await h.outbox.ready();
  const target = agent(7);
  h.outbox.send({
    kind: 5,
    content: "",
    tags: [
      ["e", target],
      ["k", String(INSTRUCTIONS_KIND)],
    ],
  });
  await flush();
  expect(h.signatures).toHaveLength(1);
  const sent = h.signatures[0].event.tags.map(([name, value]) =>
    name === "e" && value === target ? [name, "a".repeat(64)] : [name, value],
  );
  // The same corpus drives the native `is_deletion` test in src-tauri/src/relay/tests.rs.
  const admitted = deletionContract.find((c) => "outbox" in c && c.outbox);
  expect(admitted?.accepted).toBe(true);
  expect(sent).toEqual(admitted?.tags);
});
