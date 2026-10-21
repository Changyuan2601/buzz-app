import { afterEach, expect, it, vi } from "vitest";
import { loadPreview } from "./preview";

afterEach(() => vi.unstubAllGlobals());

it.each([true, false])(
  "bounds actual streamed bytes even when Content-Length is misleading (declared=%s)",
  async (declared) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100_001));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            headers: declared ? { "Content-Length": "1" } : {},
          }),
      ),
    );
    await expect(
      loadPreview("/api/relay/media", new AbortController().signal),
    ).rejects.toThrow("100 KB preview limit");
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it("rejects a declared oversize response before consuming the body", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "Content-Length": "100001" },
        }),
    ),
  );
  await expect(
    loadPreview("/api/relay/media", new AbortController().signal),
  ).rejects.toThrow("100 KB preview limit");
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([new Uint8Array([0xff]), new Uint8Array([0x61, 0])])(
  "refuses binary data advertised as text (%j)",
  async (bytes) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    await expect(
      loadPreview("/api/relay/media", new AbortController().signal),
    ).rejects.toThrow("Download it instead");
  },
);

it("decodes UTF-8 across stream chunks at the size limit", async () => {
  const bytes = new TextEncoder().encode(`${"a".repeat(99_996)}📝`);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 99_998));
      controller.enqueue(bytes.slice(99_998));
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(stream)),
  );
  await expect(
    loadPreview("/api/relay/media", new AbortController().signal),
  ).resolves.toBe(`${"a".repeat(99_996)}📝`);
});

it("uses the capped native preview request and explains a host size rejection", async () => {
  const source = `buzz-media://localhost/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.md`)}`;
  const fetch = vi.fn(async () => new Response(null, { status: 413 }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(loadPreview(source, signal)).rejects.toThrow(
    "100 KB preview limit",
  );
  expect(fetch).toHaveBeenCalledWith(`${source}?preview`, { signal });
});
