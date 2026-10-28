import type { OpeningFrameRequest, OpeningFrameResult } from "./opening-frame";

function dataUrl(blob: Blob) {
  return new Promise<string | undefined>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve(typeof reader.result === "string" ? reader.result : undefined);
    reader.readAsDataURL(blob);
  });
}

self.onmessage = async (event: MessageEvent<OpeningFrameRequest>) => {
  const { id, frame, width, height } = event.data;
  const reply = (result: Omit<OpeningFrameResult, "id">) =>
    self.postMessage({ id, ...result } satisfies OpeningFrameResult);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    // A worker without 2D canvas support leaves the capture to the page.
    if (!context) return reply({ unsupported: true });
    context.drawImage(frame, 0, 0, width, height);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.8,
    });
    reply({ poster: await dataUrl(blob) });
  } catch {
    reply({});
  } finally {
    frame.close();
  }
};
