import { expect, it } from "vitest";
import { cleanEncodedJpeg } from "./jpeg-metadata";

const segment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 255,
  ...payload,
];
const text = (value: string) => [...new TextEncoder().encode(value)];
const jfif = segment(0xe0, [...text("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const adobe = segment(0xee, [...text("Adobe"), 0, 100, 0, 0, 0, 0, 1]);
const scan = [
  ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  42,
  0xff,
  0,
  7,
  0xff,
  0xd0,
  8,
];

it("removes APP/COM metadata between progressive scans without changing encoded pixels", async () => {
  const pixels = [
    0xff,
    0xd8,
    ...jfif,
    ...adobe,
    ...segment(0xdb, [1, 2]),
    ...scan,
    ...scan,
    0xff,
    0xd9,
  ];
  const dirty = new Uint8Array([
    0xff,
    0xd8,
    ...jfif,
    ...adobe,
    ...segment(0xe1, text("Exif\0private")),
    ...segment(0xe2, text("ICC_PROFILE\0private")),
    ...segment(0xed, text("Photoshop 3.0\0private")),
    ...segment(0xe0, text("noncanonical")),
    ...segment(0xee, text("noncanonical")),
    ...segment(0xdb, [1, 2]),
    ...scan,
    ...segment(0xfe, text("private comment")),
    ...scan,
    0xff,
    0xd9,
    ...text("trailing private data"),
  ]);
  const original = dirty.slice();
  const result = cleanEncodedJpeg(dirty);
  expect(result.type).toBe("image/jpeg");
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(
    new Uint8Array(pixels),
  );
  expect(dirty).toEqual(original);
});

it.each([
  [],
  [0xff, 0xd8],
  [0xff, 0xd8, 0xff],
  [0xff, 0xd8, 0xff, 0xe1, 0, 1],
  [0xff, 0xd8, 0xff, 0xe1, 0, 20, 1],
  [0xff, 0xd8, ...scan],
])("rejects truncated or malformed encoder output: %j", (...bytes) => {
  expect(() => cleanEncodedJpeg(new Uint8Array(bytes))).toThrow(/malformed/);
});
