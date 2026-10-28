import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getEventHash, verifyEvent } from "nostr-tools";
import { keypair, hostSigner, signed } from "./testing";
import { validSignature, type SignatureCheck } from "./signature-check";

// Count the dependency verifier: worker reads must not fall back to it.
vi.mock("nostr-tools", async (original) => {
  const actual = await original<typeof import("nostr-tools")>();
  return { ...actual, verifyEvent: vi.fn(actual.verifyEvent) };
});

type Reply = (data: { id: number; checks: SignatureCheck[] }) => unknown;
let reply: Reply;
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: SignatureCheck[][] = [];
  terminated = false;
  constructor(readonly url: URL) {
    workers.push(this);
  }
  postMessage(data: { id: number; checks: SignatureCheck[] }) {
    this.posted.push(data.checks);
    setTimeout(() => {
      const answer = reply(data);
      if (answer === "crash") this.onerror?.();
      else this.onmessage?.({ data: answer });
    });
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.resetModules();
  workers.length = 0;
  reply = ({ id, checks }) => ({ id, valid: checks.map(validSignature) });
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const key = keypair();
const events = Array.from({ length: 9 }, (_, i) =>
  signed(key, { kind: 9, created_at: i, content: `${i}`, tags: [["h", "a"]] }),
);
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

async function connect(payload: () => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(payload())),
  );
  const { connectSignedTransport } = await import("./transport");
  return connectSignedTransport(
    hostSigner(key),
    "https://pool.test",
    key.pubkey,
  );
}
const filters = [{ kinds: [9], "#h": ["a"], limit: 9 }];

it("checks new signatures in workers, keeps response order and reuses proofs", async () => {
  const transport = await connect(() => wire([...events, events[0]]));
  const read = await transport.query(filters);
  expect(read.map((event) => event.id)).toEqual(
    [...events, events[0]].map((event) => event?.id),
  );
  expect(Object.isFrozen(read[0])).toBe(true);
  const posted = workers.flatMap((worker) => worker.posted.flat());
  expect(posted.map(([, id]) => id).sort()).toEqual(
    events.map((event) => event.id).sort(),
  );
  expect(workers[0]?.url.pathname).toMatch(/signature\.worker\.ts$/);
  expect(verifyEvent).not.toHaveBeenCalled();
  const messages = workers.flatMap((worker) => worker.posted).length;
  expect(await transport.query(filters)).toHaveLength(10);
  expect(workers.flatMap((worker) => worker.posted)).toHaveLength(messages);
});

it("rejects a whole response for one bad signature and memoizes no failure", async () => {
  let payload = wire(events);
  payload[4].sig = "0".repeat(128);
  const transport = await connect(() => payload);
  await expect(transport.query(filters)).rejects.toThrow(/malformed/);
  await expect(transport.query(filters)).rejects.toThrow(/malformed/);
  const checked = workers.flatMap((worker) => worker.posted.flat());
  expect(checked.filter(([sig]) => sig === "0".repeat(128))).toHaveLength(2);
  // A worker cannot vouch for an event whose hash does not match its ID.
  reply = ({ id, checks }) => ({ id, valid: checks.map(() => true) });
  payload = wire(events);
  payload[2].content = "changed";
  await expect(transport.query(filters)).rejects.toThrow(/malformed/);
});

it("verifies on the main thread when a worker crashes or answers malformed", async () => {
  const forged = wire(events);
  forged[7].sig = forged[6].sig;
  const crashed: boolean[] = [];
  for (const answer of [
    () => "crash",
    ({ id }: { id: number }) => ({ id, valid: [] }),
    ({ id, checks }: { id: number; checks: SignatureCheck[] }) => ({
      id,
      valid: checks.map(() => 1),
    }),
  ]) {
    vi.resetModules();
    workers.length = 0;
    reply = answer;
    let payload = wire(events);
    const transport = await connect(() => payload);
    expect(await transport.query(filters)).toHaveLength(9);
    payload = forged;
    await expect(transport.query(filters)).rejects.toThrow(/malformed/);
    crashed.push(workers.some((worker) => worker.terminated));
  }
  expect(crashed).toEqual([true, false, false]);
  expect(verifyEvent).toHaveBeenCalled(); // reads after a crash use the old path
});

it("matches the dependency verifier's verdicts", () => {
  const other = keypair();
  for (const [index, event] of events.entries()) {
    const flipped = event.sig.charAt(index * 13) === "0" ? "1" : "0";
    const sig = (at: number) =>
      `${event.sig.slice(0, at)}${flipped}${event.sig.slice(at + 1)}`;
    for (const variant of [
      event,
      { ...event, sig: sig(index * 13) },
      { ...event, sig: sig(64 + index * 7) },
      { ...event, sig: "f".repeat(128) },
      { ...event, sig: "0".repeat(128) },
      rehashed(event, other.pubkey),
      rehashed(event, "f".repeat(64)),
    ]) {
      const check: SignatureCheck = [variant.sig, variant.id, variant.pubkey];
      expect(validSignature(check)).toBe(verifyEvent(wire(variant)));
    }
  }
});

function rehashed(event: (typeof events)[number], pubkey: string) {
  const next = { ...wire(event), pubkey };
  return { ...next, id: getEventHash(next) };
}
