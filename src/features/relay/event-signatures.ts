import { verifyEvent, type Event } from "nostr-tools";

type Pending = (valid: readonly boolean[] | undefined) => void;
const pending = new Map<number, Pending>();
const poolSize = 2;
let nextRequest = 0;
// undefined: not started yet; null: unavailable, so verify on this thread.
let workers: Worker[] | null | undefined;

function signatureWorkers() {
  if (workers !== undefined) return workers;
  workers = null;
  if (typeof Worker === "undefined") return workers;
  const pool: Worker[] = [];
  try {
    for (let index = 0; index < poolSize; index++)
      pool.push(
        new Worker(new URL("./event-signatures.worker.ts", import.meta.url), {
          type: "module",
        }),
      );
  } catch {
    for (const worker of pool) worker.terminate();
    return workers;
  }
  for (const worker of pool) {
    worker.onmessage = (
      message: MessageEvent<{ id: number; valid: boolean[] }>,
    ) => {
      pending.get(message.data.id)?.(message.data.valid);
      pending.delete(message.data.id);
    };
    // A worker that cannot load or crashes hands every request back to this thread.
    worker.onerror = () => {
      for (const worker of pool) worker.terminate();
      workers = null;
      for (const settle of pending.values()) settle(undefined);
      pending.clear();
    };
  }
  workers = pool;
  return workers;
}

/** Schnorr checks are the costly, DOM-free part of admitting relay reads. A
 * small worker pool verifies signatures and hashes; callers keep other checks. */
export async function verifySignatures(
  events: readonly Event[],
): Promise<readonly boolean[]> {
  const pool = signatureWorkers();
  if (pool) {
    const id = nextRequest++;
    const target = pool[id % pool.length];
    const valid = await new Promise<readonly boolean[] | undefined>(
      (resolve) => {
        pending.set(id, resolve);
        target?.postMessage({ id, events });
      },
    );
    if (valid) return valid;
  }
  return events.map((event) => verifyEvent(event));
}
