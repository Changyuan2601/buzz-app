self.onmessage = async (
  event: MessageEvent<{
    id: number;
    bitmap: ImageBitmap;
    type: string;
    quality: number;
  }>,
) => {
  const { id, bitmap, type, quality } = event.data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context");
    context.drawImage(bitmap, 0, 0);
    self.postMessage({
      id,
      blob: await canvas.convertToBlob({ type, quality }),
    });
  } catch {
    self.postMessage({ id });
  } finally {
    bitmap.close();
  }
};
