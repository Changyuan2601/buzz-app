import type { CheckedResponse } from "./event-checks.ts";

type Settle = (checked: CheckedResponse | undefined) => void;
const pending = new Map<number, Settle>();
let nextRequest = 0;
let nextMemo = 0;
// undefined: not started yet; null: unavailable, so this thread checks reads.
let worker: Worker | null | undefined;
const released =
  typeof FinalizationRegistry === "undefined"
    ? undefined
    : new FinalizationRegistry<number>((memo) =>
        worker?.postMessage({ release: memo }),
      );

function intakeWorker() {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./event-intake.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return worker;
  }
  worker.onmessage = (
    message: MessageEvent<{ id: number; checked?: CheckedResponse }>,
  ) => {
    pending.get(message.data.id)?.(message.data.checked);
    pending.delete(message.data.id);
  };
  // A worker that cannot load or crashes hands its reads back to this thread.
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    for (const settle of pending.values()) settle(undefined);
    pending.clear();
  };
  return worker;
}

/** Relay read responses are parsed, checked and signature-verified in one
 * shared module worker, so none of that CPU runs on the main thread. Each
 * connection keeps its own proof memo there. Undefined without workers. */
export function createResponseIntake() {
  if (!intakeWorker()) return;
  const memo = nextMemo++;
  const intake = (text: string) =>
    new Promise<CheckedResponse | undefined>((resolve) => {
      const target = intakeWorker();
      if (!target) return resolve(undefined);
      const id = nextRequest++;
      pending.set(id, resolve);
      target.postMessage({ id, memo, text });
    });
  released?.register(intake, memo);
  return intake;
}
