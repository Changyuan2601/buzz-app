import { validSignature, type SignatureCheck } from "./signature";

type Job = {
  checks: readonly SignatureCheck[];
  valid: boolean[];
  sent: number;
  left: number;
  resolve: (valid: boolean[]) => void;
};
type Batch = { job: Job; start: number; checks: readonly SignatureCheck[] };
type Slot = { worker: Worker; batch?: Batch; failed?: true };
// Signature checks are pure CPU over public inputs; a few dedicated workers keep
// first-seen history from competing with input and rendering on the main thread.
const SIZE = Math.max(
  1,
  Math.min(2, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
);
// Each worker holds one small batch, and reads take turns batch by batch, as
// main-thread verification yielded between batches: a foreground read never
// waits behind a large speculative one.
const BATCH = 12;
const waiting: Job[] = [];
let pool: Slot[] | null | undefined;

/** Whether relay reads can check signatures off the main thread. Connections
 * call it early so the workers load before the first read needs them. */
export function startSignatureWorkers(): boolean {
  return workers() !== null;
}

/** Verdicts in input order. A worker that fails or answers malformed never skips
 * a check: its batch is verified on the main thread instead. */
export function verifySignatures(
  checks: readonly SignatureCheck[],
): Promise<boolean[]> {
  const slots = workers();
  if (!slots || checks.length === 0)
    return Promise.resolve(checks.map(validSignature));
  return new Promise((resolve) => {
    waiting.push({ checks, valid: [], sent: 0, left: checks.length, resolve });
    pump(slots);
  });
}

function pump(slots: readonly Slot[]) {
  for (const slot of slots) {
    if (slot.batch || slot.failed) continue;
    const job = waiting.shift();
    if (!job) return;
    const start = job.sent;
    const checks = job.checks.slice(start, start + BATCH);
    job.sent += checks.length;
    if (job.sent < job.checks.length) waiting.push(job);
    slot.batch = { job, start, checks };
    try {
      slot.worker.postMessage(checks);
    } catch {
      fail(slots, slot);
    }
  }
  // Without a live worker, finish queued checks here rather than drop them.
  if (slots.every((slot) => slot.failed))
    for (const job of waiting.splice(0)) {
      const start = job.sent;
      job.sent = job.checks.length;
      settle({ job, start, checks: job.checks.slice(start) });
    }
}

function settle(batch: Batch, verdicts?: unknown) {
  const valid =
    Array.isArray(verdicts) &&
    verdicts.length === batch.checks.length &&
    verdicts.every((verdict) => typeof verdict === "boolean")
      ? verdicts
      : batch.checks.map(validSignature);
  const { job, start } = batch;
  for (const [index, verdict] of valid.entries())
    job.valid[start + index] = verdict;
  job.left -= valid.length;
  if (job.left === 0) job.resolve(job.valid);
}

function fail(slots: readonly Slot[], slot: Slot) {
  if (slot.failed) return;
  slot.failed = true;
  pool = null; // later reads use the main-thread path
  slot.worker.terminate();
  const { batch } = slot;
  slot.batch = undefined;
  if (batch) settle(batch);
  pump(slots);
}

function workers(): Slot[] | null {
  if (pool !== undefined) return pool;
  pool = null;
  if (typeof Worker === "undefined") return pool;
  const slots: Slot[] = [];
  try {
    for (let index = 0; index < SIZE; index++) {
      const slot: Slot = {
        worker: new Worker(new URL("./signature.worker.ts", import.meta.url), {
          type: "module",
        }),
      };
      slot.worker.onmessage = (event: MessageEvent<unknown>) => {
        const { batch } = slot;
        if (!batch) return;
        slot.batch = undefined;
        settle(batch, event.data);
        pump(slots);
      };
      slot.worker.onerror = () => fail(slots, slot);
      slot.worker.onmessageerror = () => fail(slots, slot);
      slots.push(slot);
    }
  } catch {
    for (const slot of slots) slot.worker.terminate();
    return pool;
  }
  pool = slots;
  return pool;
}
