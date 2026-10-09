// Structural sanitizers mirror old Buzz's media_gif/media_animated helpers.
// Pixel/frame bytes are copied, never flattened. Relay validation remains final.
const text = (b: Uint8Array, a: number, z: number) =>
  String.fromCharCode(...b.subarray(a, z));
const view = (b: Uint8Array) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);
const invalid = () => new Error("Image container is malformed.");
type Chunk = { kind: string; payload: Uint8Array; raw: Uint8Array };

export function pngChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = view(bytes).getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw invalid();
    const kind = text(bytes, offset + 4, offset + 8);
    chunks.push({
      kind,
      payload: bytes.subarray(offset + 8, end - 4),
      raw: bytes.subarray(offset, end),
    });
    if (kind === "IEND") return chunks;
    offset = end;
  }
  throw invalid();
}
export function snapshotChunk(chunks: Chunk[]): Uint8Array | undefined {
  return chunks.find(
    ({ kind, payload }) =>
      kind === "tEXt" &&
      ["buzz_agent_snapshot\0", "buzz_team_snapshot\0"].some(
        (key) => text(payload, 0, key.length) === key,
      ),
  )?.raw;
}
function oriented(bytes: Uint8Array): boolean {
  const b = text(bytes, 0, 6) === "Exif\0\0" ? bytes.subarray(6) : bytes;
  if (b.length < 8 || !["II", "MM"].includes(text(b, 0, 2))) return false;
  const little = text(b, 0, 2) === "II";
  const v = view(b);
  if (v.getUint16(2, little) !== 42) return false;
  const offset = v.getUint32(4, little);
  if (offset + 2 > b.length) return false;
  const count = v.getUint16(offset, little);
  for (let i = 0; i < count; i++) {
    const p = offset + 2 + i * 12;
    if (p + 12 > b.length) return false;
    if (
      v.getUint16(p, little) === 0x112 &&
      v.getUint16(p + 2, little) === 3 &&
      v.getUint32(p + 4, little) === 1
    ) {
      const orientation = v.getUint16(p + 8, little);
      return orientation >= 2 && orientation <= 8;
    }
  }
  return false;
}
function assertAnimationAppearance(chunks: Chunk[], icc: string, exif: string) {
  if (chunks.some((c) => c.kind === icc))
    throw new Error(
      "Animated images with an ICC profile cannot be cleaned without changing their colors.",
    );
  if (chunks.some((c) => c.kind === exif && oriented(c.payload)))
    throw new Error(
      "Animated images with EXIF orientation cannot be cleaned without changing their appearance.",
    );
}
const pngRendering = new Set([
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "tRNS",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);
export function isPngRenderingChunk(kind: string): boolean {
  return !(kind.charCodeAt(0) & 32) || pngRendering.has(kind);
}
export function pngNeedsPixelTransform(chunks: Chunk[]): boolean {
  return chunks.some(
    (chunk) =>
      chunk.kind === "iCCP" ||
      (chunk.kind === "eXIf" && oriented(chunk.payload)),
  );
}
export function cleanPng(
  bytes: Uint8Array,
  snapshot?: Uint8Array,
  animated = false,
): Blob {
  const chunks = pngChunks(bytes);
  if (chunks[0]?.kind !== "IHDR") throw invalid();
  if (animated) assertAnimationAppearance(chunks, "iCCP", "eXIf");
  const parts: BlobPart[] = [bytes.slice(0, 8)];
  for (const chunk of chunks) {
    if (isPngRenderingChunk(chunk.kind)) parts.push(chunk.raw.slice());
    if (chunk.kind === "IHDR" && snapshot) parts.push(snapshot.slice());
  }
  return new Blob(parts, { type: "image/png" });
}
function riffChunks(bytes: Uint8Array, start: number, end: number): Chunk[] {
  const result: Chunk[] = [];
  for (let offset = start; offset < end; ) {
    if (offset + 8 > end) throw invalid();
    const length = view(bytes).getUint32(offset + 4, true);
    const next = offset + 8 + length + (length & 1);
    if (next > end) throw invalid();
    result.push({
      kind: text(bytes, offset, offset + 4),
      payload: bytes.subarray(offset + 8, offset + 8 + length),
      raw: bytes.subarray(offset, next),
    });
    offset = next;
  }
  return result;
}
export function webpChunks(bytes: Uint8Array): Chunk[] {
  if (bytes.length < 12) throw invalid();
  const end = view(bytes).getUint32(4, true) + 8;
  if (end < 12 || end > bytes.length) throw invalid();
  return riffChunks(bytes, 12, end);
}
function riffChunk(kind: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(8 + payload.length + (payload.length & 1));
  result.set(new TextEncoder().encode(kind));
  view(result).setUint32(4, payload.length, true);
  result.set(payload, 8);
  return result;
}
export function webpNeedsPixelTransform(chunks: Chunk[]): boolean {
  return chunks.some(
    (c) => c.kind === "ICCP" || (c.kind === "EXIF" && oriented(c.payload)),
  );
}
export function cleanWebp(bytes: Uint8Array, animated: boolean): Blob {
  const chunks = webpChunks(bytes);
  if (animated) assertAnimationAppearance(chunks, "ICCP", "EXIF");
  const parts: Uint8Array[] = [];
  for (const { kind, payload } of chunks) {
    if (!["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"].includes(kind))
      continue;
    let clean = payload.slice();
    if (kind === "VP8X") {
      if (!clean.length) throw invalid();
      clean[0] = (clean[0] ?? 0) & ~0x2c;
    }
    if (kind === "ANMF") {
      if (payload.length < 16) throw invalid();
      const frame = [payload.slice(0, 16)];
      let alpha = false;
      let image = false;
      for (const child of riffChunks(payload, 16, payload.length)) {
        if (child.kind === "ALPH") {
          if (alpha || image) throw invalid();
          alpha = true;
        } else if (["VP8 ", "VP8L"].includes(child.kind)) {
          if (image || (alpha && child.kind === "VP8L")) throw invalid();
          image = true;
        } else continue;
        frame.push(riffChunk(child.kind, child.payload));
      }
      if (!image) throw invalid();
      clean = concat(frame);
    }
    parts.push(riffChunk(kind, clean));
  }
  const header = new TextEncoder().encode("RIFF\0\0\0\0WEBP");
  view(header).setUint32(
    4,
    4 + parts.reduce((sum, p) => sum + p.length, 0),
    true,
  );
  return new Blob([header, ...parts.map((p) => p.slice())], {
    type: "image/webp",
  });
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
export function cleanGif(b: Uint8Array): Blob {
  if (b.length < 13) throw invalid();
  let i = 13 + ((b[10] ?? 0) & 0x80 ? 3 << (((b[10] ?? 0) & 7) + 1) : 0);
  if (i > b.length) throw invalid();
  const parts = [b.slice(0, i)];
  const blocks = (start: number) => {
    let p = start;
    while (p < b.length) {
      const length = b[p++];
      if (length === undefined) throw invalid();
      if (!length) return p;
      p += length;
    }
    throw invalid();
  };
  while (i < b.length) {
    const start = i;
    if (b[i] === 0x3b) {
      parts.push(b.slice(i, i + 1));
      return new Blob(parts, { type: "image/gif" });
    }
    if (b[i] === 0x2c) {
      if (i + 10 > b.length) throw invalid();
      i = blocks(
        i +
          11 +
          ((b[i + 9] ?? 0) & 0x80 ? 3 << (((b[i + 9] ?? 0) & 7) + 1) : 0),
      );
      parts.push(b.slice(start, i));
    } else if (b[i] === 0x21) {
      const label = b[i + 1];
      i += 2;
      if (label === 0xf9) {
        if (b[i] !== 4 || i + 6 > b.length || b[i + 5] !== 0) throw invalid();
        i += 6;
        parts.push(b.slice(start, i));
      } else if (label === 0xff) {
        if (b[i] !== 11 || i + 12 > b.length) throw invalid();
        const app = text(b, i + 1, i + 12);
        const data = i + 12;
        i = blocks(data);
        if (["NETSCAPE2.0", "ANIMEXTS1.0"].includes(app)) {
          if (b[data] !== 3 || b[data + 1] !== 1 || data + 5 > b.length)
            throw invalid();
          parts.push(b.slice(start, data + 4), new Uint8Array([0]));
        }
      } else i = blocks(i);
    } else throw invalid();
  }
  throw invalid();
}
