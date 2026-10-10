import { expect, it } from "vitest";
import { canvasMapBlocks, mapSpecPoints, parseMapSpec } from "./canvas-map";

it("finds every map block in Canvas Markdown and ignores other code", () => {
  const markdown = [
    "# Stores",
    "```map",
    '{ "center": [-122.42, 37.77] }',
    "```",
    "```json",
    '{ "center": [0, 0] }',
    "```",
    "~~~map",
    '{ "center": [2.35, 48.86] }',
    "~~~",
  ].join("\n");
  expect(canvasMapBlocks(markdown)).toEqual([
    '{ "center": [-122.42, 37.77] }',
    '{ "center": [2.35, 48.86] }',
  ]);
  expect(canvasMapBlocks("no maps here")).toEqual([]);
});

it("parses markers, lines and a clamped viewport", () => {
  const result = parseMapSpec(
    JSON.stringify({
      center: [-122.42, 37.77],
      zoom: 30,
      height: 5000,
      markers: [{ lng: -122.4, lat: 37.78, label: "HQ", color: "#f00" }],
      lines: [
        {
          coordinates: [
            [-122.4, 37.78],
            [-122.41, 37.76],
          ],
        },
      ],
    }),
  );
  expect(result).toEqual({
    ok: true,
    spec: {
      center: [-122.42, 37.77],
      zoom: 22,
      height: 800,
      markers: [{ lng: -122.4, lat: 37.78, label: "HQ", color: "#f00" }],
      lines: [
        {
          coordinates: [
            [-122.4, 37.78],
            [-122.41, 37.76],
          ],
          label: undefined,
          color: undefined,
        },
      ],
    },
  });
  if (result.ok)
    expect(mapSpecPoints(result.spec)).toEqual([
      [-122.4, 37.78],
      [-122.4, 37.78],
      [-122.41, 37.76],
    ]);
});

it.each([
  ["{", "Map block is not valid JSON."],
  ["[]", "Map block must be a JSON object."],
  ["{}", "Map block needs a center, markers, or lines."],
  ['{ "center": [200, 0] }', "center must be [lng, lat]."],
  ['{ "markers": [{ "lng": 0 }] }', "markers[0] needs valid lng/lat."],
  [
    '{ "lines": [{ "coordinates": [[0, 0]] }] }',
    "lines[0] needs at least two [lng, lat] coordinates.",
  ],
])("rejects %s", (source, error) => {
  expect(parseMapSpec(source)).toEqual({ ok: false, error });
});
