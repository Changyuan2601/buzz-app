/** A video preview's opening frame as a JPEG data URL, at most 640px wide.
 * `drawn` is false when no 2D context could draw it, so the export is blank. */
export type OpeningFrameExport = Readonly<{ poster: string; drawn: boolean }>;

export type OpeningFrameRequest = {
  id: number;
  frame: ImageBitmap;
  width: number;
  height: number;
};
export type OpeningFrameResult = {
  id: number;
  poster?: string | undefined;
  unsupported?: boolean;
};

let worker: Worker | null | undefined;
let nextRequest = 0;
const pending = new Map<number, (result: OpeningFrameResult) => void>();

function frameWorker() {
  if (worker !== undefined) return worker;
  if (
    typeof Worker !== "function" ||
    typeof OffscreenCanvas !== "function" ||
    typeof createImageBitmap !== "function"
  ) {
    worker = null;
    return worker;
  }
  try {
    worker = new Worker(new URL("./opening-frame.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    worker = null;
    return worker;
  }
  worker.onmessage = (event: MessageEvent<OpeningFrameResult>) => {
    const settle = pending.get(event.data.id);
    pending.delete(event.data.id);
    settle?.(event.data);
  };
  worker.onerror = () => {
    // A worker that cannot load hands every capture back to the page.
    worker?.terminate();
    worker = null;
    for (const settle of pending.values()) settle({ id: 0, unsupported: true });
    pending.clear();
  };
  return worker;
}

/** The page-thread export: Chromium encodes toBlob off the main thread, while
 * WebKit encodes inline. */
function exportOnPage(
  element: HTMLVideoElement,
  width: number,
  height: number,
): Promise<OpeningFrameExport | undefined> {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context?.drawImage(element, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return resolve(undefined);
          const reader = new FileReader();
          reader.onloadend = () =>
            resolve(
              typeof reader.result === "string"
                ? { poster: reader.result, drawn: Boolean(context) }
                : undefined,
            );
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        0.8,
      );
    } catch {
      resolve(undefined);
    }
  });
}

/** Exports the frame the video shows now. Where a worker can draw, the frame
 * leaves the page as an ImageBitmap and the worker scales and encodes it;
 * otherwise, or if the worker declines, a page canvas does. Undefined means
 * the frame could not be exported. */
export async function exportOpeningFrame(
  element: HTMLVideoElement,
): Promise<OpeningFrameExport | undefined> {
  const scale = Math.min(1, 640 / element.videoWidth);
  const width = Math.max(1, Math.round(element.videoWidth * scale));
  const height = Math.max(1, Math.round(element.videoHeight * scale));
  const target = frameWorker();
  if (!target) return exportOnPage(element, width, height);
  let frame: ImageBitmap;
  try {
    frame = await createImageBitmap(element);
  } catch {
    return exportOnPage(element, width, height);
  }
  const result = await new Promise<OpeningFrameResult>((resolve) => {
    const id = ++nextRequest;
    pending.set(id, resolve);
    try {
      target.postMessage({ id, frame, width, height }, [frame]);
    } catch {
      pending.delete(id);
      frame.close();
      resolve({ id, unsupported: true });
    }
  });
  if (result.unsupported) {
    if (worker === target) {
      target.terminate();
      worker = null;
    }
    return exportOnPage(element, width, height);
  }
  return result.poster ? { poster: result.poster, drawn: true } : undefined;
}
