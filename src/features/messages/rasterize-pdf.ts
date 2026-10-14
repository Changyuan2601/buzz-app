/**
 * Rasterizes single-page PDFs into image attachments with pdf.js. Buzz ships
 * neither its wasm decoders nor its CMaps, so scans in wasm-only formats and
 * fonts using a predefined CMap (non-embedded CJK) fall back to the file chip
 * until `wasmUrl`/`cMapUrl` assets are shipped.
 */
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { UploadError } from "../relay/attachments";
import { MIB, mediaByteLimit } from "../relay/attachment-limits";

/** Rendering buffers the whole document; larger PDFs stay file attachments. */
const RASTERIZE_MAX_BYTES = 32 * MIB;
/** Under WebKit's canvas area limit and the 25 MP cap used for images. */
const MAX_EDGE_PX = 4096;
/**
 * pdf.js decodes these only through wasm modules Buzz does not ship, and it
 * drops an undecodable image XObject even with `stopAtErrors`, so such a scan
 * would render as a blank page. Stream dictionaries are never packed into
 * object streams, so the filter name is usually visible in the raw bytes;
 * `/JPX` and `/CCF` are the abbreviations pdf.js accepts for any stream.
 * Accepted fail-open gaps, caught later by the blank-page check: `#`-escaped
 * names such as `/JBIG2#44ecode`, and an indirect `/Filter 7 0 R` whose value
 * lives in an object stream.
 */
const WASM_ONLY_FILTERS = /\/(?:(?:JBIG2|JPX|CCITTFax)Decode|JPX|CCF)\b/;
/** The blank-page check halves the page until its long edge fits this. */
const SAMPLE_EDGE_PX = 64;

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

/**
 * pdf.js paints nothing for an image XObject or annotation it cannot decode,
 * even with `stopAtErrors`, so a wholly white page means content was lost (an
 * empty page is not worth attaching either). The page is halved until its long
 * edge fits the sample, drawing at exactly half size each time (a fractional
 * trailing pixel blends into the white fill of the ceil-sized scratch canvas):
 * an exact 2:1 `drawImage` is a box filter in both engines, whereas any other
 * ratio, a single-shot downscale or a 153:77 odd step, is sampled and can
 * miss a hairline and read pure white.
 */
function isBlank(canvas: HTMLCanvasElement): boolean {
  const scratch: HTMLCanvasElement[] = [];
  try {
    let source = canvas;
    let context: CanvasRenderingContext2D | null = null;
    while (Math.max(source.width, source.height) > SAMPLE_EDGE_PX) {
      const half = document.createElement("canvas");
      scratch.push(half);
      half.width = Math.max(1, Math.ceil(source.width / 2));
      half.height = Math.max(1, Math.ceil(source.height / 2));
      context = half.getContext("2d");
      if (!context) return false;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, half.width, half.height);
      context.drawImage(source, 0, 0, source.width / 2, source.height / 2);
      source = half;
    }
    context ??= source.getContext("2d");
    if (!context) return false;
    const { data } = context.getImageData(0, 0, source.width, source.height);
    return data.every((channel) => channel === 255);
  } finally {
    for (const half of scratch) {
      half.width = 0;
      half.height = 0;
    }
  }
}

/** Page 1 as a PNG, or undefined when pdf.js cannot render the whole single page. */
async function renderSinglePage(
  file: File,
  signal: AbortSignal,
): Promise<Blob | undefined> {
  const canvas = document.createElement("canvas");
  let loading: { destroy(): Promise<void> } | undefined;
  try {
    const data = await raced(file.arrayBuffer(), signal);
    if (WASM_ONLY_FILTERS.test(new TextDecoder("latin1").decode(data)))
      return undefined;
    const { getDocument, GlobalWorkerOptions } = await raced(
      import("pdfjs-dist"),
      signal,
    );
    GlobalWorkerOptions.workerSrc = workerUrl;
    const task = getDocument({
      data,
      useWasm: false,
      verbosity: 0,
      // A partial render would silently replace the PDF; any evaluator error
      // keeps the file attachment instead.
      stopAtErrors: true,
    });
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
    if (isBlank(canvas)) return undefined;
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
