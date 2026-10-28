import { readFile } from "node:fs/promises";

// Playwright's path fulfillment ignores Range. WebKit needs honest partial
// responses when the fixture video seeks/loops. Keep non-range delivery intact.
// Only single byte ranges are supported; ignore malformed/multiple/other units.
export async function mediaResponse(path, contentType, range) {
  const full = { path, contentType };
  const match = /^bytes=\s*(\d*)-(\d*)$/i.exec(range?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return full;
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first !== null && last !== null && last < first) return full;

  // Like path fulfillment, read the exact asset per request; no media/cache swap.
  const data = await readFile(path);
  const size = BigInt(data.length);
  if (size === 0n) return full;
  const start = first ?? (last < size ? size - last : 0n);
  const end =
    first === null || last === null || last >= size ? size - 1n : last;
  const headers = { "accept-ranges": "bytes" };
  if (start >= size || end < start)
    return {
      status: 416,
      contentType,
      body: "",
      headers: {
        ...headers,
        "content-range": `bytes */${size}`,
        "content-length": "0",
      },
    };
  const body = data.subarray(Number(start), Number(end + 1n));
  return {
    status: 206,
    contentType,
    body,
    headers: {
      ...headers,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(body.length),
    },
  };
}
