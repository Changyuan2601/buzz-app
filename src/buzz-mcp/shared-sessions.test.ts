import { beforeEach, expect, it, vi } from "vitest";
import type { BuzzClient } from "./client";
import { callTool, TOOLS } from "./tools";
import {
  listSharedChats,
  readSharedChat,
} from "../features/shared-chats/shared-chats";

vi.mock("../features/shared-chats/shared-chats", () => ({
  listSharedChats: vi.fn(),
  readSharedChat: vi.fn(),
}));
const client = { pubkey: "a".repeat(64) } as BuzzClient;
const cursor = { until: 100, before_id: "b".repeat(64) };
beforeEach(() => vi.clearAllMocks());

it("lists the current channel and binds its audience even from a thread", async () => {
  const result = { entries: [], cursor, complete: false, errors: [] };
  vi.mocked(listSharedChats).mockResolvedValue(result);
  expect(
    await callTool(
      client,
      { channel: "destination", root: "thread" },
      "shared_sessions",
      {
        query: "notifications",
        cursor,
        limit: 20,
      },
    ),
  ).toBe(JSON.stringify(result));
  expect(listSharedChats).toHaveBeenCalledWith(client, "destination", {
    query: "notifications",
    cursor,
    limit: 20,
    audience: "destination",
  });
});

it("reads for the current audience and preserves the source citation", async () => {
  const result = {
    id: "source",
    messages: [],
    citation: "buzz://session/source",
    complete: true,
  };
  vi.mocked(readSharedChat).mockResolvedValue(result);
  expect(
    await callTool(client, { channel: "destination" }, "shared_sessions", {
      action: "read",
      source: "source",
      cursor,
      limit: 10,
    }),
  ).toBe(JSON.stringify(result));
  expect(readSharedChat).toHaveBeenCalledWith(client, "destination", "source", {
    cursor,
    limit: 10,
  });
});

it.each([
  { channel: "private" },
  { audience: "private" },
  { action: "other" },
  { action: "read" },
  { action: "read", source: " " },
  { source: "source" },
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
  { query: 5 },
  { cursor: null },
  { cursor: { until: 1, before_id: "invalid" } },
  { cursor: { ...cursor, audience: "private" } },
  { action: "read", source: "source", query: "text" },
])(
  "refuses malformed or audience-changing arguments before reading: %j",
  async (args) => {
    await expect(
      callTool(client, { channel: "destination" }, "shared_sessions", args),
    ).rejects.toThrow();
    expect(listSharedChats).not.toHaveBeenCalled();
    expect(readSharedChat).not.toHaveBeenCalled();
  },
);

it("cannot read without a turn destination", async () => {
  await expect(callTool(client, {}, "shared_sessions", {})).rejects.toThrow(
    "current channel",
  );
  expect(listSharedChats).not.toHaveBeenCalled();
});

it("propagates access failure without returning source data", async () => {
  vi.mocked(readSharedChat).mockRejectedValue(new Error("Source unavailable"));
  await expect(
    callTool(client, { channel: "destination" }, "shared_sessions", {
      action: "read",
      source: "source",
    }),
  ).rejects.toThrow("Source unavailable");
});

it("exposes the tool through the shared catalog without an audience override", () => {
  const schema = TOOLS.find(
    (tool) => tool.name === "shared_sessions",
  )?.inputSchema;
  if (!schema) throw new Error("shared_sessions tool is missing");
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties).not.toHaveProperty("channel");
  expect(schema.properties).not.toHaveProperty("audience");
});

it("passes contributing share receipts without changing the answering audience", async () => {
  vi.mocked(readSharedChat).mockResolvedValue({
    id: "source",
    messages: [],
    citation: "link",
    complete: true,
  });
  const shareIds = ["a".repeat(64), "b".repeat(64)];
  await callTool(client, { channel: "destination" }, "shared_sessions", {
    action: "read",
    source: "source",
    share_ids: shareIds,
  });
  expect(readSharedChat).toHaveBeenCalledWith(client, "destination", "source", {
    shareIds,
  });
});

it.each(
  [
    [],
    ["bad"],
    ["A".repeat(64)],
    ["a".repeat(64), "a".repeat(64)],
    Array.from({ length: 33 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    ),
    "a".repeat(64),
    null,
  ].map((shareIds) => ({ shareIds })),
)("rejects invalid share receipts: %j", async ({ shareIds }) => {
  await expect(
    callTool(client, { channel: "destination" }, "shared_sessions", {
      action: "read",
      source: "source",
      share_ids: shareIds,
    }),
  ).rejects.toThrow("share_ids");
  expect(readSharedChat).not.toHaveBeenCalled();
});

it("rejects share receipts on list", async () => {
  await expect(
    callTool(client, { channel: "destination" }, "shared_sessions", {
      share_ids: ["a".repeat(64)],
    }),
  ).rejects.toThrow("only supported by read");
  expect(listSharedChats).not.toHaveBeenCalled();
});
