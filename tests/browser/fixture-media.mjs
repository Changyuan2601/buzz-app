import { readFile } from "node:fs/promises";

export function mediaReadyForPausedSeek(videos) {
  return (
    videos.length > 0 &&
    videos.every(
      (video) =>
        video.paused && video.readyState >= 1 && !video.seeking && !video.error,
    )
  );
}

export async function playFixtureVideos(videos, pausedSeek) {
  if (pausedSeek)
    await Promise.all(
      videos.map((video) => {
        video.muted = true;
        video.loop = true;
        // Linux WebKit's segment-loop initialization can repeat the opening
        // frame indefinitely. One observed seek while paused initializes its
        // supported flushing-loop path before the once-only play call.
        return new Promise((resolve, reject) => {
          const finish = (error) => {
            video.removeEventListener("seeked", seeked);
            video.removeEventListener("error", failed);
            if (error) reject(error);
            else resolve();
          };
          const seeked = () => {
            if (!video.seeking) finish();
          };
          const failed = () =>
            finish(
              new Error(video.error?.message ?? "Fixture media seek failed"),
            );
          video.addEventListener("seeked", seeked);
          video.addEventListener("error", failed, { once: true });
          try {
            video.currentTime = video.currentTime < 0.05 ? 0.1 : 0;
          } catch (error) {
            finish(error);
          }
        });
      }),
    );
  await Promise.all(
    videos.map(async (video) => {
      video.muted = true;
      video.loop = true;
      await video.play();
    }),
  );
}

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
