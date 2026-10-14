/** Strip encoder-added metadata only AFTER pixels have been oriented and drawn
 * into the sRGB canvas. Applying this to source photos would lose appearance. */
export function cleanEncodedJpeg(bytes: Uint8Array): Blob {
  const invalid = () => new Error("Image container is malformed.");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  const parts: BlobPart[] = [bytes.slice(0, 2)];
  let offset = 2;
  let scan = false;
  while (offset < bytes.length) {
    const start = offset;
    if (scan) {
      // Keep entropy-coded bytes, stuffed FF bytes and restart markers intact.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = bytes[offset + 1];
        if (
          marker === 0 ||
          (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)
        ) {
          offset += 2;
          continue;
        }
        break;
      }
      parts.push(bytes.slice(start, offset));
      scan = false;
      continue;
    }
    if (bytes[offset++] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      parts.push(new Uint8Array([0xff, 0xd9]));
      return new Blob(parts, { type: "image/jpeg" });
    }
    if (marker === undefined || marker === 0 || marker === 0xd8)
      throw invalid();
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.slice(start, offset));
      continue;
    }
    if (offset + 2 > bytes.length) throw invalid();
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) throw invalid();
    const payload = bytes.subarray(offset + 2, end);
    const identifier = (text: string) =>
      [...text].every((char, i) => payload[i] === char.charCodeAt(0));
    // Match the relay's canonical JFIF/Adobe exceptions. All other APP/COM
    // sections are metadata, including WebKit EXIF and Chromium ICC output.
    const canonical =
      (marker === 0xe0 &&
        payload.length >= 14 &&
        identifier("JFIF\0") &&
        payload.length === 14 + 3 * (payload[12] ?? 0) * (payload[13] ?? 0)) ||
      (marker === 0xee && payload.length === 12 && identifier("Adobe"));
    if (canonical || (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe))
      parts.push(bytes.slice(start, end));
    offset = end;
    scan = marker === 0xda;
  }
  throw invalid();
}
