// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningFrameRequest, OpeningFrameResult } from "./opening-frame";

const FRAME = `data:image/jpeg;base64,${btoa("frame")}`;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static reply: (
    request: OpeningFrameRequest,
  ) => Omit<OpeningFrameResult, "id"> = () => ({
    poster: "data:image/jpeg;base64,worker",
  });
  onmessage: ((event: MessageEvent<OpeningFrameResult>) => void) | null = null;
  onerror: (() => void) | null = null;
  posted: OpeningFrameRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: OpeningFrameRequest) {
    this.posted.push(request);
    const result = { id: request.id, ...FakeWorker.reply(request) };
    queueMicrotask(() =>
      this.onmessage?.(new MessageEvent("message", { data: result })),
    );
  }
  terminate() {
    this.terminated = true;
  }
}

function video() {
  const element = document.createElement("video");
  for (const [key, value] of [
    ["videoWidth", 1280],
    ["videoHeight", 720],
  ] as const)
    Object.defineProperty(element, key, { configurable: true, value });
  return element;
}

function stubPageCanvas() {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) =>
      callback(new Blob(["frame"], { type: "image/jpeg" })),
    );
  return { drawImage, toBlob };
}

const bitmap = { close: vi.fn() } as unknown as ImageBitmap;

beforeEach(() => {
  vi.resetModules();
  FakeWorker.instances = [];
  FakeWorker.reply = () => ({ poster: "data:image/jpeg;base64,worker" });
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("scales and encodes the frame in one shared worker", async () => {
  const { toBlob } = stubPageCanvas();
  const { exportOpeningFrame } = await import("./opening-frame");
  const element = video();
  await expect(exportOpeningFrame(element)).resolves.toEqual({
    poster: "data:image/jpeg;base64,worker",
    drawn: true,
  });
  await exportOpeningFrame(video());
  expect(createImageBitmap).toHaveBeenCalledWith(element);
  expect(FakeWorker.instances).toHaveLength(1);
  expect(FakeWorker.instances[0]?.posted).toEqual([
    expect.objectContaining({ frame: bitmap, width: 640, height: 360 }),
    expect.objectContaining({ frame: bitmap, width: 640, height: 360 }),
  ]);
  expect(toBlob).not.toHaveBeenCalled();
});

it("reports a failed worker encode as no frame", async () => {
  FakeWorker.reply = () => ({});
  const { exportOpeningFrame } = await import("./opening-frame");
  await expect(exportOpeningFrame(video())).resolves.toBeUndefined();
});

it("exports on the page when the worker cannot draw", async () => {
  FakeWorker.reply = () => ({ unsupported: true });
  const { drawImage } = stubPageCanvas();
  const { exportOpeningFrame } = await import("./opening-frame");
  const element = video();
  await expect(exportOpeningFrame(element)).resolves.toEqual({
    poster: FRAME,
    drawn: true,
  });
  expect(drawImage).toHaveBeenCalledWith(element, 0, 0, 640, 360);
  expect(FakeWorker.instances[0]?.terminated).toBe(true);
  // Later captures skip the declined worker.
  await exportOpeningFrame(video());
  expect(FakeWorker.instances).toHaveLength(1);
  expect(createImageBitmap).toHaveBeenCalledTimes(1);
});

it("exports on the page when the frame cannot become a bitmap", async () => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      throw new Error("unsupported source");
    }),
  );
  const { drawImage } = stubPageCanvas();
  const { exportOpeningFrame } = await import("./opening-frame");
  await expect(exportOpeningFrame(video())).resolves.toEqual({
    poster: FRAME,
    drawn: true,
  });
  expect(drawImage).toHaveBeenCalledTimes(1);
});

it("exports on the page without OffscreenCanvas", async () => {
  vi.stubGlobal("OffscreenCanvas", undefined);
  const { drawImage } = stubPageCanvas();
  const { exportOpeningFrame } = await import("./opening-frame");
  await expect(exportOpeningFrame(video())).resolves.toEqual({
    poster: FRAME,
    drawn: true,
  });
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(FakeWorker.instances).toHaveLength(0);
});
