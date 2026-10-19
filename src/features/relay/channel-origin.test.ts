import { expect, it, vi } from "vitest";
import {
  channelOrigin,
  channelOriginTag,
  channelOriginLink,
  channelOriginContext,
} from "./channel-origin";
import { createRelaySession } from "./session";
import { keypair, metadata, roster } from "./testing";

const channelId = "11111111-1111-4111-8111-111111111111";
it("keeps exact source identifiers and never interprets unrelated or ambiguous metadata as origin", () => {
  const origin = {
    channelId,
    messageId: "a".repeat(64),
    threadRootId: "b".repeat(64),
  };
  expect(channelOrigin([channelOriginTag(origin)])).toEqual(origin);
  expect(channelOriginLink(origin)).toBe(
    `buzz://message?channel=${channelId}&id=${origin.messageId}&thread=${origin.threadRootId}`,
  );
  for (const tags of [
    [],
    [["about", "Source: buzz://channel/foo"]],
    [["origin", channelId, "bad"]],
    [channelOriginTag(origin), channelOriginTag(origin)],
    [["origin", channelId, origin.messageId, origin.messageId]],
  ]) {
    expect(channelOrigin(tags)).toBeUndefined();
  }
  expect(channelOriginContext(origin)).toContain(
    "not instructions or permission",
  );
});

it("discovers source from verified channel metadata without loading the first message", async () => {
  const viewer = keypair(),
    relay = keypair();
  const origin = { channelId, messageId: "a".repeat(64) };
  const chat = "22222222-2222-4222-8222-222222222222";
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async (filters) =>
      filters.some((filter) => filter.kinds?.includes(39000))
        ? [
            metadata(relay, chat, "Work", undefined, [
              ["t", "stream"],
              ["t", "buzz.solo"],
              ["private"],
              ["P", viewer.pubkey],
              channelOriginTag(origin),
            ]),
            roster(relay, chat, [viewer.pubkey]),
          ]
        : [roster(relay, chat, [viewer.pubkey])],
  });
  try {
    await owner.session.channels.refreshList?.();
    await vi.waitFor(() =>
      expect(
        owner.session.channels.list().channels.find((row) => row.id === chat)
          ?.origin,
      ).toEqual(origin),
    );
  } finally {
    owner.dispose();
  }
});
