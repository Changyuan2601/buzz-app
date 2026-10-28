import { afterEach, expect, it, vi } from "vitest";
import { verifyEvent, verifiedSymbol, type Event } from "nostr-tools";
import { keypair, signed } from "./testing";

const key = keypair();
const event = signed(key, { kind: 9, content: "worker", tags: [["h", "a"]] });
const wire = () => JSON.parse(JSON.stringify(event));
const posted: Event[][] = [];

/** Runs the real dependency verifier on structured clones, as a worker would. */
class SignatureWorker {
  static fail = false;
  onmessage?: (message: { data: unknown }) => void;
  onerror?: () => void;
  postMessage({ id, events }: { id: number; events: Event[] }) {
    posted.push(events);
    setTimeout(() => {
      if (SignatureWorker.fail) return this.onerror?.();
      const valid = structuredClone(events).map((copy) => verifyEvent(copy));
      this.onmessage?.({ data: { id, valid } });
    });
  }
  terminate() {}
}

async function verifier() {
  vi.resetModules();
  vi.stubGlobal("Worker", SignatureWorker);
  const { createEventVerifier, hasEventProof } = await import("./events");
  return { verify: createEventVerifier(), hasEventProof };
}

afterEach(() => {
  posted.length = 0;
  SignatureWorker.fail = false;
  vi.unstubAllGlobals();
});

it("verifies only new signatures off the main thread and admits owned events", async () => {
  const { verify, hasEventProof } = await verifier();
  const admitted = await verify.many([wire(), wire()]);
  expect(posted).toEqual([[event]]);
  expect(admitted).toEqual([event, event]);
  for (const record of admitted) {
    expect(record[verifiedSymbol]).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(hasEventProof(record)).toBe(true);
  }
  expect(await verify.many([wire()])).toEqual([event]);
  expect(posted).toHaveLength(1); // proof hit: rehashed here, no worker trip
  expect(verify(wire())).toEqual(event);
  expect(posted).toHaveLength(1);
});

it("rejects a response with a forged signature, tampered copy or malformed record", async () => {
  const { verify } = await verifier();
  const forged = { ...wire(), sig: "0".repeat(128) };
  await expect(verify.many([wire(), forged])).rejects.toThrow(/malformed/);
  await expect(
    verify.many([wire(), { ...wire(), content: "tampered" }]),
  ).rejects.toThrow(/malformed/);
  await expect(verify.many([{ ...wire(), kind: 1.5 }])).rejects.toThrow(
    /malformed/,
  );
  expect(posted.flat()).not.toContainEqual(
    expect.objectContaining({ kind: 1.5 }),
  );
  // A failed response never proves its other copies' signatures wrongly.
  await expect(verify.many([forged])).rejects.toThrow(/malformed/);
});

it("verifies on the main thread when the worker fails", async () => {
  const { verify } = await verifier();
  SignatureWorker.fail = true;
  expect(await verify.many([wire()])).toEqual([event]);
  await expect(
    verify.many([{ ...wire(), sig: "0".repeat(128) }]),
  ).rejects.toThrow(/malformed/);
  expect(posted).toHaveLength(1); // the failed worker is not used again
});
