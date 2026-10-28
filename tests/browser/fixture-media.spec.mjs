import { fileURLToPath } from "node:url";
import { test, expect } from "./playwright-test.mjs";
import { mediaResponse } from "./fixture-media.mjs";

const videoPath = fileURLToPath(
  new URL("../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
);

// A native decoder must render after looping/seeking, not just resolve play().
// The byte-range matrix belongs to the Node fixture-media test.
test("intercepted fixture videos render frames beyond their first loop", async ({
  page,
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
      let looped = false;
      const frame = (_, { mediaTime }) => {
        if (mediaTime < previous) looped = true;
        if (looped && mediaTime > 0.15) progress.replayed = true;
        previous = mediaTime;
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
      video.addEventListener("error", () => {
        progress.error = video.error?.message;
      });
      video.addEventListener(
        "loadeddata",
        () => {
          if (video.currentTime === 0) video.currentTime = 0.1;
        },
        { once: true },
      );
      video.muted = true;
      video.loop = true;
      video.preload = "auto";
      video.src = `https://media.fixture.test/${i}.mp4`;
      document.body.append(video);
      void video.play().catch((error) => {
        progress.error = String(error);
      });
      return progress;
    });
  });
  await expect
    .poll(() => page.evaluate(() => window.mediaProgress))
    .toEqual(
      Array.from({ length: 6 }, () => ({ replayed: true, error: null })),
    );
});
