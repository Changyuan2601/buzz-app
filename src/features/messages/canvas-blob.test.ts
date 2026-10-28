import { afterEach, beforeEach, expect, it, vi } from "vitest";

class EncoderWorker {
  static all: EncoderWorker[] = [];
  constructor() {
    EncoderWorker.all.push(this);
  }
  terminate = vi.fn();
  postMessage = vi.fn();
  onmessage?: (event: { data: { id: number; blob?: Blob } }) => void;
  onerror?: () => void;
}
const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;
const fakeCanvas = () => ({ toBlob: vi.fn() }) as unknown as HTMLCanvasElement;
const load = async () => (await import("./canvas-blob")).canvasBlob;
const settle = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  vi.resetModules();
  EncoderWorker.all = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("encodes inline without worker canvases", async () => {
  vi.stubGlobal("Worker", EncoderWorker);
  vi.stubGlobal("OffscreenCanvas", undefined);
  const canvasBlob = await load();
  const canvas = fakeCanvas();
  const toBlob = vi.mocked(canvas.toBlob);
  const callback = vi.fn();
  canvasBlob(canvas, callback, "image/jpeg", 0.8);
  expect(toBlob).toHaveBeenCalledWith(callback, "image/jpeg", 0.8);
  expect(EncoderWorker.all).toHaveLength(0);
});

it("encodes a bitmap snapshot in one shared worker", async () => {
  vi.stubGlobal("Worker", EncoderWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  const snapshots = [bitmap(), bitmap()];
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => snapshots.shift()),
  );
  const canvasBlob = await load();
  const canvas = fakeCanvas();
  const toBlob = vi.mocked(canvas.toBlob);
  const first = vi.fn();
  const second = vi.fn();
  canvasBlob(canvas, first, "image/jpeg", 0.8);
  canvasBlob(canvas, second, "image/jpeg", 0.8);
  await settle();
  const worker = EncoderWorker.all[0] as EncoderWorker;
  expect(EncoderWorker.all).toHaveLength(1);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  const [message, transfer] = worker.postMessage.mock.calls[1] ?? [];
  expect(message).toMatchObject({ id: 1, type: "image/jpeg", quality: 0.8 });
  expect(transfer).toEqual([message.bitmap]);
  const blob = new Blob(["frame"], { type: "image/jpeg" });
  worker.onmessage?.({ data: { id: 1, blob } });
  expect(second).toHaveBeenCalledWith(blob);
  expect(first).not.toHaveBeenCalled();
  expect(toBlob).not.toHaveBeenCalled();
});

it("falls back to the canvas when the worker cannot encode or load", async () => {
  vi.stubGlobal("Worker", EncoderWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap()),
  );
  const canvasBlob = await load();
  const canvas = fakeCanvas();
  const toBlob = vi.mocked(canvas.toBlob);
  const callback = vi.fn();
  canvasBlob(canvas, callback, "image/jpeg", 0.8);
  canvasBlob(canvas, callback, "image/jpeg", 0.8);
  await settle();
  const worker = EncoderWorker.all[0] as EncoderWorker;
  worker.onmessage?.({ data: { id: 0 } });
  expect(toBlob).toHaveBeenCalledTimes(1);
  worker.onerror?.();
  expect(toBlob).toHaveBeenCalledTimes(2);
  expect(worker.terminate).toHaveBeenCalled();
  canvasBlob(canvas, callback, "image/jpeg", 0.8);
  expect(toBlob).toHaveBeenCalledTimes(3);
  expect(EncoderWorker.all).toHaveLength(1);
});
