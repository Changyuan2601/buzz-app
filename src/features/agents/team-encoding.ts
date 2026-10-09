import { pngChunks } from "../messages/image-metadata";
import type { TeamSnapshot } from "./team-bundles";

const keyword = "buzz_team_snapshot\0";
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const placeholder =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAaX1ZFcAAAAASUVORK5CYII=";
export const MAX_TEAM_SNAPSHOT_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_TEAM_SNAPSHOT_PNG_BYTES = 16 * 1024 * 1024;
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function binary(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return result;
}
export function encodeTeam(
  snapshot: TeamSnapshot,
  format: "json" | "png",
): Blob {
  const json = new TextEncoder().encode(JSON.stringify(snapshot));
  if (json.length > MAX_TEAM_SNAPSHOT_JSON_BYTES)
    throw new Error("Team snapshot exceeds the size limit");
  if (format === "json") return new Blob([json], { type: "application/json" });
  const payload = new TextEncoder().encode(keyword + btoa(binary(json)));
  const chunk = new Uint8Array(payload.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(payload, 8);
  view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  const image = Uint8Array.from(atob(placeholder), (c) => c.charCodeAt(0));
  const chunks = pngChunks(image);
  const result = new Blob(
    [
      signature,
      ...chunks.flatMap((item) =>
        item.kind === "IHDR" ? [item.raw.slice(), chunk] : [item.raw.slice()],
      ),
    ],
    { type: "image/png" },
  );
  if (result.size > MAX_TEAM_SNAPSHOT_PNG_BYTES)
    throw new Error("Team snapshot exceeds the size limit");
  return result;
}
/** Decode only the portable manifest. Native preview remains the validation authority. */
export function decodeTeamFile(bytes: Uint8Array): string {
  const png = signature.every((byte, index) => bytes[index] === byte);
  if (!png) {
    if (bytes.length > MAX_TEAM_SNAPSHOT_JSON_BYTES)
      throw new Error("Team snapshot exceeds the size limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (bytes.length > MAX_TEAM_SNAPSHOT_PNG_BYTES)
    throw new Error("Team snapshot exceeds the size limit");
  const matches = pngChunks(bytes).filter(
    (chunk) =>
      chunk.kind === "tEXt" &&
      new TextDecoder().decode(chunk.payload.subarray(0, keyword.length)) ===
        keyword,
  );
  const chunk = matches[0];
  if (matches.length !== 1 || !chunk)
    throw new Error("PNG does not contain a buzz_team_snapshot tEXt chunk");
  const view = new DataView(
    chunk.raw.buffer,
    chunk.raw.byteOffset,
    chunk.raw.byteLength,
  );
  if (
    view.getUint32(chunk.raw.length - 4) !==
    crc32(chunk.raw.subarray(4, chunk.raw.length - 4))
  )
    throw new Error("Invalid PNG snapshot checksum");
  const encoded = new TextDecoder()
    .decode(chunk.payload.subarray(keyword.length))
    .trim();
  if (encoded.length > Math.ceil(MAX_TEAM_SNAPSHOT_JSON_BYTES / 3) * 4)
    throw new Error("Team snapshot exceeds the size limit");
  const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (decoded.length > MAX_TEAM_SNAPSHOT_JSON_BYTES)
    throw new Error("Team snapshot exceeds the size limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
}
