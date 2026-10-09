// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { encodeAgentSnapshot, type AgentSnapshot } from "../agents/snapshot";
import { pngChunks, snapshotChunk } from "../messages/image-metadata";
import { uploadAvatar } from "./avatar-upload";

const uploadAttachment = vi.fn(async (file: File) => ({
  type: file.type,
  url: "https://relay.example.test/media/avatar.png",
}));
vi.mock("../communities/connection", () => ({
  connectCommunityTransport: async () => ({ uploadAttachment }),
}));

it("strips private snapshot metadata at the avatar upload boundary", async () => {
  const manifest: AgentSnapshot = {
    format: "buzz-agent-snapshot",
    version: 1,
    definition: { name: "Inert", runtime: "buzz-agent" },
    profile: { displayName: "Inert" },
    memory: {
      level: "core",
      entries: [{ slug: "core", body: "INERT_PRIVATE_MEMORY" }],
    },
  };
  const bytes = encodeAgentSnapshot(manifest, "png");
  const file = new File([bytes], "snapshot.agent.png", { type: "image/png" });
  const signal = new AbortController().signal;
  expect(snapshotChunk(pngChunks(bytes))).toBeDefined();
  await uploadAvatar(file, "https://relay.example.test", signal);
  const outgoing = uploadAttachment.mock.calls[0]?.[0];
  expect(outgoing).toBeDefined();
  if (!outgoing) throw new Error("Avatar upload was not attempted");
  const avatarBytes = new Uint8Array(await outgoing.arrayBuffer());
  expect(snapshotChunk(pngChunks(avatarBytes))).toBeUndefined();
  expect(
    pngChunks(avatarBytes).find((chunk) => chunk.kind === "IDAT")?.raw,
  ).toEqual(pngChunks(bytes).find((chunk) => chunk.kind === "IDAT")?.raw);
});

it.each(["iCCP", "eXIf"])(
  "redraws a still PNG with %s before uploading and excludes private metadata",
  async (kind) => {
    uploadAttachment.mockClear();
    const manifest: AgentSnapshot = {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: { name: "Inert" },
      profile: { displayName: "Inert" },
      memory: { level: "none", entries: [] },
    };
    const source = encodeAgentSnapshot(manifest, "png");
    const exif = new Uint8Array(28);
    exif.set(new TextEncoder().encode("Exif\0\0II"));
    const tiff = new DataView(exif.buffer, 6);
    tiff.setUint16(2, 42, true);
    tiff.setUint32(4, 8, true);
    tiff.setUint16(8, 1, true);
    tiff.setUint16(10, 0x112, true);
    tiff.setUint16(12, 3, true);
    tiff.setUint32(14, 1, true);
    tiff.setUint16(18, 6, true);
    const header = pngChunks(source)[0]?.raw;
    if (!header) throw new Error("Missing PNG header");
    const bytes = new Uint8Array([
      ...source.subarray(0, 8),
      ...header,
      ...pngChunk(kind, kind === "iCCP" ? new Uint8Array([1]) : exif),
      ...source.subarray(8 + header.length),
    ]);
    const redraw = encodeAgentSnapshot(manifest, "png");
    const bitmap = { width: 1, height: 1, close: vi.fn() };
    const originalBitmap = globalThis.createImageBitmap;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => bitmap),
    });
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: vi.fn() } as never);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback) => {
        callback(new Blob([redraw], { type: "image/png" }));
      });
    try {
      await uploadAvatar(
        new File([bytes], "avatar.png", { type: "image/png" }),
        "https://relay.example.test",
        new AbortController().signal,
      );
      expect(createImageBitmap).toHaveBeenCalledOnce();
      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(getContext.mock.results.length).toBeGreaterThan(0);
      expect(toBlob).toHaveBeenCalledOnce();
      const sent = uploadAttachment.mock.calls[0]?.[0];
      if (!sent) throw new Error("Avatar was not uploaded");
      expect(
        snapshotChunk(pngChunks(new Uint8Array(await sent.arrayBuffer()))),
      ).toBeUndefined();
    } finally {
      getContext.mockRestore();
      toBlob.mockRestore();
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: originalBitmap,
      });
    }
  },
);

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, -4)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(8 + payload.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}
