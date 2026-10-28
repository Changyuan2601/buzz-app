import { fileURLToPath } from "node:url";
import { test, expect } from "./playwright-test.mjs";
import {
  mediaResponse,
  mediaReadyForPausedSeek,
  playFixtureVideos,
} from "./fixture-media.mjs";

const videoPath = fileURLToPath(
  new URL("../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
);

// A native decoder must render after looping/seeking, not just resolve play().
// The byte-range matrix belongs to the Node fixture-media test.
test("intercepted fixture videos render three full loops", async ({
  page,
  browserName,
}) => {
  await page.route("https://media.fixture.test/*.mp4", async (route) =>
    route.fulfill(
      await mediaResponse(
        videoPath,
        "video/mp4",
        route.request().headers().range,
      ),
    ),
  );
  await page.setContent("<body></body>");
  await page.evaluate(() => {
    window.mediaProgress = Array.from({ length: 6 }, (_, i) => {
      const video = document.createElement("video");
      const progress = { replayed: false, error: null };
      let previous = 0;
      let loops = 0;
      let peak = 0;
      const frame = (_, { mediaTime }) => {
        if (mediaTime < previous - 0.5) {
          if (peak > video.duration * 0.75) loops++;
          peak = mediaTime;
        }
        peak = Math.max(peak, mediaTime);
        if (loops >= 3 && mediaTime > 0.25) progress.replayed = true;
        previous = mediaTime;
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
      video.addEventListener("error", () => {
        progress.error = video.error?.message;
      });
      video.preload = "auto";
      video.src = `https://media.fixture.test/${i}.mp4`;
      document.body.append(video);
      return progress;
    });
  });
  const pausedSeek = browserName === "webkit" && process.platform === "linux";
  if (pausedSeek)
    await expect
      .poll(() => page.locator("video").evaluateAll(mediaReadyForPausedSeek))
      .toBe(true);
  await page.locator("video").evaluateAll(playFixtureVideos, pausedSeek);
  await expect
    .poll(() => page.evaluate(() => window.mediaProgress))
    .toEqual(
      Array.from({ length: 6 }, () => ({ replayed: true, error: null })),
    );
});
