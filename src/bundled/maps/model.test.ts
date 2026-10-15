import { describe, expect, it } from "vitest";
import type { ChannelMessage } from "../../features/relay/contracts";
import {
  INITIAL_MAP,
  WINTERMUTE,
  historicalMap,
  applyMapReply,
  mapPrompt,
  mapRequest,
  mapReply,
  parseMap,
  wintermute,
} from "./model";
const root = "a".repeat(64);
describe("dataset map references", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  it("preserves layers on viewport-only replies and clears them only explicitly", () => {
    const current = { ...INITIAL_MAP, datasets: [id] };
    const reply = mapReply(
      row({
        content: JSON.stringify({
          requestId: "request",
          message: "Moved",
          map: { center: [1, 2], zoom: 12 },
        }),
      }),
      "maps",
      root,
      "request",
    );
    expect(reply && applyMapReply(current, reply).datasets).toEqual([id]);
    const clear = mapReply(
      row({
        content: JSON.stringify({
          requestId: "request",
          message: "Cleared",
          map: { ...INITIAL_MAP, datasets: [] },
        }),
      }),
      "maps",
      root,
      "request",
    );
    expect(clear && applyMapReply(current, clear).datasets).toEqual([]);
    expect(
      parseMap({ ...INITIAL_MAP, datasets: ["https://evil.example/data"] }),
    ).toBeUndefined();
  });
});
const row = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: "b".repeat(64),
  authorId: WINTERMUTE,
  channelId: "maps",
  threadRootId: root,
  createdAt: 1,
  content: JSON.stringify({
    requestId: "request",
    message: "Here is the place.",
    map: INITIAL_MAP,
  }),
  attachments: [],
  replyCount: 0,
  reactions: [],
  mentions: [],
  participants: [],
  ...overrides,
});
describe("restoring channel map history", () => {
  const request = "12345678-1234-1234-1234-123456789abc";
  const question = row({
    id: root,
    authorId: "f".repeat(64),
    threadRootId: undefined,
    delivery: "accepted",
    mentions: [WINTERMUTE],
    content: mapPrompt(request, "Show cities", INITIAL_MAP),
  });
  const mapped = {
    ...INITIAL_MAP,
    markers: [{ coordinates: [-122, 37] as [number, number], label: "City" }],
  };
  const answer = row({
    content: JSON.stringify({
      requestId: request,
      message: "Cities",
      map: mapped,
    }),
  });
  const agents = new Set([WINTERMUTE]);
  it("restores the latest correlated map, preserving it after a text-only answer", () => {
    const older = row({
      content: JSON.stringify({
        requestId: request,
        message: "Earlier",
        map: INITIAL_MAP,
      }),
    });
    const text = row({
      content: JSON.stringify({ requestId: request, message: "Hello" }),
    });
    expect(
      historicalMap([question, older, answer, text], "maps", agents),
    ).toEqual(mapped);
  });
  it.each([
    { mentions: [] },
    { channelId: "other" },
    { edited: true as const },
    { signerId: "c".repeat(64) },
    { delivery: "sending" as const },
  ])(
    "does not restore from an unaccepted or unaddressed request: %j",
    (change) => {
      expect(
        historicalMap(
          [row({ ...question, ...change }), answer],
          "maps",
          agents,
        ),
      ).toBeUndefined();
    },
  );
  it("requires the request and a currently selectable agent", () => {
    expect(historicalMap([answer], "maps", agents)).toBeUndefined();
    expect(
      historicalMap([question, answer], "maps", new Set()),
    ).toBeUndefined();
    expect(
      historicalMap(
        [question, row({ ...answer, signerId: "c".repeat(64) })],
        "maps",
        agents,
      ),
    ).toBeUndefined();
  });
});
it("includes viewport and selection but keeps map datasets out of the model prompt", () => {
  const context = {
    ...INITIAL_MAP,
    center: [10, 20] as [number, number],
    zoom: 15,
    selected: { coordinates: [11, 21] as [number, number], label: "Store A" },
    markers: [{ coordinates: [11, 21] as [number, number], label: "Store A" }],
    bounds: [
      [9, 19],
      [12, 22],
    ] as [[number, number], [number, number]],
  };
  const prompt = mapPrompt("request", "What is near the selection?", context);
  expect(prompt).toContain('"center":[10,20]');
  expect(prompt).toContain('"markerCount":1');
  expect(prompt).toContain('"coordinates":[11,21]');
  expect(prompt).not.toContain("Store A");
  expect(prompt).not.toContain(
    `"markers":[${JSON.stringify(context.markers[0])}`,
  );
  expect(prompt).toContain("top-level post in this same channel");
  expect(prompt).toContain("without --reply-to");
  expect(prompt).toContain("What is near the selection?");
  expect(prompt).toContain('"requestId":"request"');
});
it("resolves the selected Wintermute identity, not a same-name or archived agent", () => {
  const selectable = [
    { pubkey: "c".repeat(64), name: "Wintermute", managed: false },
  ];
  const choices = { selectable };
  expect(wintermute(choices)).toBeUndefined();
  selectable.push({ pubkey: WINTERMUTE, name: "Wintermute", managed: false });
  expect(wintermute(choices)?.pubkey).toBe(WINTERMUTE);
});
it("defaults to the community-managed Wintermute in this channel, requiring a mention when ambiguous", () => {
  const clone = { pubkey: "c".repeat(64), name: "Wintermute", managed: true };
  const original = { pubkey: WINTERMUTE, name: "Wintermute", managed: false };
  const choices = { selectable: [original, clone] };
  expect(wintermute(choices, [clone.pubkey])?.pubkey).toBe(clone.pubkey);
  expect(wintermute(choices, [])?.pubkey).toBe(WINTERMUTE);
  const second = { ...clone, pubkey: "d".repeat(64) };
  expect(
    wintermute({ selectable: [original, clone, second] }, [
      clone.pubkey,
      second.pubkey,
    ]),
  ).toBeUndefined();
});
describe("signed reply admission", () => {
  it("accepts only the selected agent's correlated reply in the Maps thread", () => {
    expect(mapReply(row(), "maps", root, "request")).toEqual({
      message: "Here is the place.",
      map: INITIAL_MAP,
      preserveDatasets: true,
    });
  });
  it.each([
    { authorId: "c".repeat(64) },
    { signerId: "c".repeat(64) },
    { edited: true as const },
    { channelId: "other" },
    { threadRootId: "c".repeat(64) },
    { delivery: "sending" as const },
    {
      content: JSON.stringify({
        requestId: "old-request",
        message: "Stale",
        map: INITIAL_MAP,
      }),
    },
    {
      content: JSON.stringify({
        requestId: "request",
        message: "Bad map",
        map: { ...INITIAL_MAP, center: [999, 0] },
      }),
    },
    { content: "not JSON" },
  ])(
    "rejects unrelated, stale, undelivered or malformed data: %j",
    (change) => {
      expect(mapReply(row(change), "maps", root, "request")).toBeUndefined();
    },
  );
  it("accepts the runtime's top-level DM final answer when its nonce matches", () => {
    expect(
      mapReply(row({ threadRootId: undefined }), "maps", root, "request")?.map,
    ).toEqual(INITIAL_MAP);
  });
  it("allows a conversational answer without changing the map", () => {
    expect(
      mapReply(
        row({
          content: JSON.stringify({
            requestId: "request",
            message: "An answer",
          }),
        }),
        "maps",
        root,
        "request",
      ),
    ).toEqual({ message: "An answer" });
  });
});
it("validates geometry and bounds, drops unknown executable fields, and returns independent data", () => {
  const input = {
    ...INITIAL_MAP,
    markers: [{ coordinates: [-122, 37], label: "<script>alert(1)</script>" }],
    lines: [
      {
        coordinates: [
          [-122, 37],
          [-123, 38],
        ],
        label: "Line",
      },
    ],
    script: "run()",
  };
  const parsed = parseMap(input);
  expect(parsed).toBeDefined();
  expect(parsed).not.toHaveProperty("script");
  const marker = input.markers[0];
  if (marker) marker.coordinates[0] = 999;
  expect(parsed?.markers[0]?.coordinates).toEqual([-122, 37]);
  expect(parseMap({ ...INITIAL_MAP, zoom: Infinity })).toBeUndefined();
  expect(
    parseMap({
      ...INITIAL_MAP,
      lines: [{ coordinates: [[0, 0]], label: "Not a line" }],
    }),
  ).toBeUndefined();
  expect(
    parseMap({
      ...INITIAL_MAP,
      markers: Array.from({ length: 500 }, () => ({
        coordinates: [0, 0],
        label: "place",
      })),
    }),
  ).toBeDefined();
  expect(
    parseMap({
      ...INITIAL_MAP,
      markers: Array.from({ length: 60 }, () => ({
        coordinates: [0, 0],
        label: "x".repeat(200),
      })),
    }),
  ).toBeDefined();
});

it("does not impose an extra map byte limit below the host transport", () => {
  const markers = Array.from({ length: 15 }, () => ({
    coordinates: [0, 0],
    label: "地".repeat(190),
  }));
  const map = { ...INITIAL_MAP, markers };
  expect(JSON.stringify(map).length).toBeLessThan(8000);
  expect(parseMap(map)).toBeDefined();
});

it("shows only the original multiline question from a generated request", () => {
  const request = "12345678-1234-1234-1234-123456789abc";
  expect(
    mapRequest(
      mapPrompt(request, "Show Paris\nAnd nearby stores", INITIAL_MAP),
    ),
  ).toEqual({ request, text: "Show Paris\nAnd nearby stores" });
  expect(mapRequest("Ordinary channel message")).toBeUndefined();
});

it("applies large tool replies directly without putting their records into later prompts", () => {
  const markers = Array.from({ length: 500 }, (_, index) => ({
    coordinates: [-122, 37] as [number, number],
    label: `Private seller ${index}`,
  }));
  const data = { ...INITIAL_MAP, markers };
  const content = JSON.stringify({
    requestId: "request",
    message: "Plotted 500",
    map: data,
  });
  expect(content.length).toBeGreaterThan(24000);
  const reply = mapReply(row({ content }), "maps", root, "request");
  expect(reply?.map?.markers).toHaveLength(500);
  const prompt = mapPrompt("request", "What city?", data);
  expect(prompt).toContain('"markerCount":500');
  expect(prompt).not.toContain("Private seller");
  expect(prompt.length).toBeLessThan(3000);
});
it("preserves tool-owned geometry for viewport-only replies, but supports an explicit clear", () => {
  const current = {
    ...INITIAL_MAP,
    markers: [{ coordinates: [1, 2] as [number, number], label: "Existing" }],
  };
  const reply = mapReply(
    row({
      content: JSON.stringify({
        requestId: "request",
        message: "Moved",
        map: { center: [3, 4], zoom: 14 },
      }),
    }),
    "maps",
    root,
    "request",
  );
  expect(reply).toBeDefined();
  if (!reply) throw new Error("Expected viewport reply");
  expect(applyMapReply(current, reply)).toEqual({
    ...current,
    center: [3, 4],
    zoom: 14,
  });
  const clear = mapReply(
    row({
      content: JSON.stringify({
        requestId: "request",
        message: "Cleared",
        map: { center: [3, 4], zoom: 14, markers: [] },
      }),
    }),
    "maps",
    root,
    "request",
  );
  if (!clear) throw new Error("Expected clear reply");
  expect(applyMapReply(current, clear).markers).toEqual([]);
});
