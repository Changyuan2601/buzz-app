import { validSignature, type SignatureCheck } from "./signature-check";

type Job = { checks: SignatureCheck[]; resolve: (valid: boolean[]) => void };
type Slot = { worker: Worker; jobs: Map<number, Job> };
// Signature checks are pure CPU over public inputs; a few dedicated workers keep
// first-seen history from competing with input and rendering on the main thread.
const SIZE = Math.max(
  1,
  Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
);
let pool: Slot[] | null | undefined;
let nextJob = 0;

/** Whether relay reads can check signatures off the main thread. */
export function offThreadSignatures(): boolean {
  return workers() !== null;
}

/** Verdicts in input order. A worker that fails or answers malformed never skips
 * a check: its jobs are verified on the main thread instead. */
export async function verifySignatures(
  checks: readonly SignatureCheck[],
): Promise<boolean[]> {
  const slots = workers();
  if (!slots) return checks.map(validSignature);
  const size = Math.ceil(checks.length / slots.length);
  const parts = slots
    .map(
      (slot, index) =>
        [slot, checks.slice(index * size, (index + 1) * size)] as const,
    )
    .filter(([, part]) => part.length > 0)
    .map(([slot, part]) => run(slot, part));
  return (await Promise.all(parts)).flat();
}

function run(slot: Slot, checks: SignatureCheck[]): Promise<boolean[]> {
  return new Promise((resolve) => {
    const id = nextJob++;
    slot.jobs.set(id, { checks, resolve });
    try {
      slot.worker.postMessage({ id, checks });
    } catch {
      fail(slot);
    }
  });
}

function fail(slot: Slot) {
  if (pool?.includes(slot)) pool = null;
  slot.worker.terminate();
  for (const job of slot.jobs.values())
    job.resolve(job.checks.map(validSignature));
  slot.jobs.clear();
}

function workers(): Slot[] | null {
  if (pool !== undefined) return pool;
  pool = null;
  if (typeof Worker === "undefined") return pool;
  try {
    pool = Array.from({ length: SIZE }, () => {
      const slot: Slot = {
        worker: new Worker(new URL("./signature.worker.ts", import.meta.url), {
          type: "module",
        }),
        jobs: new Map(),
      };
      slot.worker.onmessage = (
        event: MessageEvent<{ id: number; valid: unknown }>,
      ) => {
        const job = slot.jobs.get(event.data.id);
        if (!job) return;
        slot.jobs.delete(event.data.id);
        const { valid } = event.data;
        job.resolve(
          Array.isArray(valid) &&
            valid.length === job.checks.length &&
            valid.every((verdict) => typeof verdict === "boolean")
            ? valid
            : job.checks.map(validSignature),
        );
      };
      slot.worker.onerror = () => fail(slot);
      slot.worker.onmessageerror = () => fail(slot);
      return slot;
    });
  } catch {
    pool = null;
  }
  return pool;
}
