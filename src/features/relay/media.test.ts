import { afterEach, expect, it, vi } from "vitest";
import { getLogger, logLevel, setLogLevel } from "../developer/logging";
import { createMediaPreparation, saveData } from "./media";

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeImage {
  static created: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 100;
  src = "";
  referrerPolicy = "";
  decode = vi.fn(async () => {});
  constructor() {
    FakeImage.created.push(this);
  }
}

function stubImages() {
  FakeImage.created = [];
  vi.stubGlobal("Image", FakeImage);
  return FakeImage.created;
}

const flushDecode = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

it.each([
  [100, true],
  [21000, false],
])("a %ipx-wide original is explicitly decoded: %s", async (width, decoded) => {
  const created = stubImages();
  createMediaPreparation().prepare(["a"]);
  const image = created[0];
  if (!image?.onload) throw new Error("image not requested");
  image.naturalWidth = width;
  image.onload();
  await flushDecode();
  // Oversized originals are not decoded just to prepare an avatar.
  expect(image.decode).toHaveBeenCalledTimes(decoded ? 1 : 0);
});

it("Save-Data disables warming but nothing else", () => {
  stubImages();
  vi.stubGlobal("navigator", { connection: { saveData: true } });
  expect(saveData()).toBe(true);
  const media = createMediaPreparation();
  media.prepare(["a", "b"]);
  media.warm(["c"]);
  expect(media.stats()).toEqual({
    active: 0,
    queued: 0,
    prefetched: 0,
    decoded: 0,
  });
  expect(FakeImage.created).toHaveLength(0);

  vi.stubGlobal("navigator", { connection: { saveData: false } });
  media.prepare(["a"]);
  expect(FakeImage.created).toHaveLength(1);

  vi.stubGlobal("navigator", {});
  expect(saveData()).toBe(false);
});

it("avatar completion diagnostics never expose signed URL credentials", async () => {
  const created = stubImages();
  const logger = getLogger("relay");
  const reporters = [...logger.options.reporters];
  const previous = logLevel();
  const lines: string[] = [];
  logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
  const media = createMediaPreparation();
  try {
    setLogLevel("debug");
    media.prepare(["https://media.test/avatar?token=AVATAR_SECRET_306"]);
    created[0]?.onload?.();
    await flushDecode();
    expect(lines.join(" ")).toContain("avatar ok 100x100");
    expect(lines.join(" ")).not.toContain("AVATAR_SECRET_306");
    expect(lines.join(" ")).not.toContain("media.test");
  } finally {
    media.dispose();
    logger.setReporters(reporters);
    setLogLevel(previous);
  }
});
