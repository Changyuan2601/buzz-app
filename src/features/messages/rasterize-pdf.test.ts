// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { UploadError } from "../relay/attachments";
import { isPdf, pageScale, pdfPageImage } from "./rasterize-pdf";

// pdf.js needs a real canvas; jsdom has none, so the library is faked here and
// the browser spec exercises the real worker, renderer and PNG encoder.
const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
}));
vi.mock("pdfjs-dist", () => pdfjs);
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/pdf.worker.mjs",
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fakePdf(numPages = 1, [width, height] = [612, 792]) {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel() {} }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    }),
    render,
  };
  const loading = deferred<{ numPages: number; getPage(): Promise<unknown> }>();
  const destroy = vi.fn(async () => {});
  pdfjs.getDocument.mockReturnValue({ promise: loading.promise, destroy });
  return {
    render,
    destroy,
    loading,
    pdf: { numPages, getPage: async () => page },
  };
}
function stubToBlob(blob: Blob | null) {
  const encodes: { width: number; height: number; type: string | undefined }[] =
    [];
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
  ) {
    encodes.push({ width: this.width, height: this.height, type });
    callback(blob);
  });
  return encodes;
}
const pdfFile = (name = "diagram.pdf", body = "%PDF-1.7\n%%EOF") =>
  new File([body], name, { type: "application/pdf", lastModified: 1234 });
afterEach(() => {
  vi.restoreAllMocks();
  pdfjs.getDocument.mockReset();
});

it("recognizes PDF headers and bounds the render scale", () => {
  expect(isPdf(new TextEncoder().encode("%PDF-1.7\n"))).toBe(true);
  expect(isPdf(new TextEncoder().encode("plain text"))).toBe(false);
  expect(isPdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(false);
  expect(pageScale(612, 792)).toBe(2);
  expect(pageScale(3150, 1800)).toBe(4096 / 3150);
  expect(pageScale(20000, 200)).toBe(0.2048);
});

it("renders page one of a single-page PDF onto a white 2x canvas as a PNG", async () => {
  const fake = fakePdf();
  fake.loading.resolve(fake.pdf);
  const encodes = stubToBlob(new Blob(["png"], { type: "image/png" }));
  const result = await pdfPageImage(pdfFile(), new AbortController().signal);
  expect(result?.name).toBe("diagram.png");
  expect(result?.type).toBe("image/png");
  expect(result?.lastModified).toBe(1234);
  expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/pdf.worker.mjs");
  expect(pdfjs.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({ useWasm: false }),
  );
  expect(fake.render).toHaveBeenCalledWith(
    expect.objectContaining({
      background: "#ffffff",
      viewport: { width: 1224, height: 1584 },
    }),
  );
  expect(encodes).toEqual([{ width: 1224, height: 1584, type: "image/png" }]);
  expect(fake.destroy).toHaveBeenCalledTimes(1);
});

it("leaves non-PDF, oversized and multi-page documents as file attachments", async () => {
  const signal = new AbortController().signal;
  expect(
    await pdfPageImage(new File(["notes"], "notes.txt"), signal),
  ).toBeUndefined();
  const large = pdfFile("large.pdf");
  Object.defineProperty(large, "size", { value: 32 * 1024 * 1024 + 1 });
  expect(await pdfPageImage(large, signal)).toBeUndefined();
  expect(pdfjs.getDocument).not.toHaveBeenCalled();

  const fake = fakePdf(2);
  fake.loading.resolve(fake.pdf);
  const encodes = stubToBlob(new Blob(["png"], { type: "image/png" }));
  expect(await pdfPageImage(pdfFile(), signal)).toBeUndefined();
  expect(fake.render).not.toHaveBeenCalled();
  expect(encodes).toEqual([]);
  expect(fake.destroy).toHaveBeenCalledTimes(1);
});

it("falls back to the original file when pdf.js rejects the document", async () => {
  const fake = fakePdf();
  fake.loading.reject(new Error("No password given"));
  expect(
    await pdfPageImage(pdfFile(), new AbortController().signal),
  ).toBeUndefined();
  expect(fake.destroy).toHaveBeenCalledTimes(1);
});

it("rethrows an abort while loading instead of falling back, and destroys the task", async () => {
  const fake = fakePdf();
  const controller = new AbortController();
  const work = pdfPageImage(pdfFile(), controller.signal);
  await vi.waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(1));
  controller.abort(new Error("Upload cancelled."));
  await expect(work).rejects.toThrow("Upload cancelled.");
  expect(fake.destroy).toHaveBeenCalledTimes(1);
  fake.loading.resolve(fake.pdf);
});

it("rejects a page image above the image byte limit", async () => {
  const fake = fakePdf();
  fake.loading.resolve(fake.pdf);
  const blob = new Blob(["png"], { type: "image/png" });
  Object.defineProperty(blob, "size", { value: 50 * 1024 * 1024 + 1 });
  stubToBlob(blob);
  await expect(
    pdfPageImage(pdfFile(), new AbortController().signal),
  ).rejects.toEqual(new UploadError("size"));
});
