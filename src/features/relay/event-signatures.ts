import { verifyEvent, type Event } from "nostr-tools";

type Pending = (valid: readonly boolean[] | undefined) => void;
const pending = new Map<number, Pending>();
let nextRequest = 0;
// undefined: not started yet; null: unavailable, so verify on this thread.
let worker: Worker | null | undefined;

function signatureWorker() {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(
      new URL("./event-signatures.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return worker;
  }
  worker.onmessage = (
    message: MessageEvent<{ id: number; valid: boolean[] }>,
  ) => {
    pending.get(message.data.id)?.(message.data.valid);
    pending.delete(message.data.id);
  };
  // A worker that cannot load or crashes hands its requests back to this thread.
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    for (const settle of pending.values()) settle(undefined);
    pending.clear();
  };
  return worker;
}

/** Schnorr checks are the costly, DOM-free part of admitting relay reads. One
 * shared worker verifies signatures and hashes; callers keep every other check. */
export async function verifySignatures(
  events: readonly Event[],
): Promise<readonly boolean[]> {
  const target = signatureWorker();
  if (target) {
    const id = nextRequest++;
    const valid = await new Promise<readonly boolean[] | undefined>(
      (resolve) => {
        pending.set(id, resolve);
        target.postMessage({ id, events });
      },
    );
    if (valid) return valid;
  }
  return events.map((event) => verifyEvent(event));
}
