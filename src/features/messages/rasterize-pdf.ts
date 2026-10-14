import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { UploadError } from "../relay/attachments";
import { MIB, mediaByteLimit } from "../relay/attachment-limits";

/** Rendering buffers the whole document; larger PDFs stay file attachments. */
const RASTERIZE_MAX_BYTES = 32 * MIB;
/** Under WebKit's canvas area limit and the 25 MP cap used for images. */
const MAX_EDGE_PX = 4096;

export function isPdf(header: Uint8Array): boolean {
  return String.fromCharCode(...header.subarray(0, 5)) === "%PDF-";
}

/** 72 pt renders at 1 px; 2x keeps text crisp until the long edge caps it. */
export function pageScale(width: number, height: number): number {
  return Math.min(2, MAX_EDGE_PX / Math.max(width, height));
}

function raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

/** Page 1 as a PNG, or undefined for multi-page, encrypted and malformed documents. */
async function renderSinglePage(
  file: File,
  signal: AbortSignal,
): Promise<Blob | undefined> {
  const canvas = document.createElement("canvas");
  let loading: { destroy(): Promise<void> } | undefined;
  try {
    const { getDocument, GlobalWorkerOptions } = await raced(
      import("pdfjs-dist"),
      signal,
    );
    GlobalWorkerOptions.workerSrc = workerUrl;
    const data = await raced(file.arrayBuffer(), signal);
    const task = getDocument({ data, useWasm: false, verbosity: 0 });
    loading = task;
    const pdf = await raced(task.promise, signal);
    if (pdf.numPages !== 1) return undefined;
    const page = await raced(pdf.getPage(1), signal);
    const points = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: pageScale(points.width, points.height),
    });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    // Pages are transparent; without a fill, dark themes would show through text.
    await raced(
      page.render({ canvas, viewport, background: "#ffffff" }).promise,
      signal,
    );
    return await raced(
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("PDF render failed.")),
          "image/png",
        ),
      ),
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined; // Keep the original PDF as a file attachment.
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    void loading?.destroy().catch(() => {});
  }
}

/** Converts a single-page PDF into an image attachment; other files pass through. */
export async function pdfPageImage(
  file: File,
  signal: AbortSignal,
): Promise<File | undefined> {
  if (!file.size || file.size > RASTERIZE_MAX_BYTES) return undefined;
  if (!isPdf(new Uint8Array(await file.slice(0, 5).arrayBuffer())))
    return undefined;
  signal.throwIfAborted();
  const blob = await renderSinglePage(file, signal);
  if (!blob) return undefined;
  if (!blob.size || blob.size > mediaByteLimit("image/png"))
    throw new UploadError("size");
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.png`, {
    type: "image/png",
    lastModified: file.lastModified,
  });
}
