import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { continuesMessageGroup, timelineRowLayout } from "./message-grouping";

const first: ChannelMessage = {
  id: "first",
  channelId: "channel",
  authorId: "author",
  content: "Hello",
  createdAt: new Date(2026, 8, 28, 12).getTime() / 1000,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};

it("groups adjacent same-author messages through the five-minute boundary", () => {
  for (const seconds of [0, 1, 299, 300]) {
    expect(
      continuesMessageGroup(first, {
        ...first,
        id: "next",
        createdAt: first.createdAt + seconds,
      }),
    ).toBe(true);
  }
});
it("breaks groups at missing history, author/channel changes, time gaps and reversed time", () => {
  expect(continuesMessageGroup(undefined, first)).toBe(false);
  for (const change of [
    { authorId: "other" },
    { channelId: "other" },
    { createdAt: first.createdAt + 301 },
    { createdAt: first.createdAt - 1 },
  ]) {
    expect(continuesMessageGroup(first, { ...first, ...change })).toBe(false);
  }
});
it("breaks at local midnight even within five minutes", () => {
  const before = {
    ...first,
    createdAt: new Date(2026, 8, 28, 23, 59).getTime() / 1000,
  };
  expect(
    continuesMessageGroup(before, {
      ...first,
      createdAt: before.createdAt + 120,
    }),
  ).toBe(false);
});
it("keeps membership events separate on either side", () => {
  const membership = {
    ...first,
    membership: {} as NonNullable<ChannelMessage["membership"]>,
  };
  expect(continuesMessageGroup(first, membership)).toBe(false);
  expect(continuesMessageGroup(membership, first)).toBe(false);
});

it("keeps thread shares separate from adjacent authored messages", () => {
  const shared = { ...first, sentFromThread: { rootId: "a".repeat(64) } };
  expect(continuesMessageGroup(first, shared)).toBe(false);
  expect(continuesMessageGroup(shared, first)).toBe(false);
});

it("keeps automation bylines on every row, even for a common signer and owner", () => {
  const workflow = { ...first, workflowOwnerId: "owner" };
  expect(continuesMessageGroup(first, workflow)).toBe(false);
  expect(continuesMessageGroup(workflow, first)).toBe(false);
  expect(continuesMessageGroup(workflow, { ...workflow, id: "next" })).toBe(
    false,
  );
});

it("lays out timeline rows exactly as pairwise day and group checks do", () => {
  const at = (
    id: string,
    minutes: number,
    change: Partial<ChannelMessage>,
  ) => ({
    ...first,
    ...change,
    id,
    createdAt: new Date(2026, 8, 28, 23, 50 + minutes).getTime() / 1000,
  });
  const rows = [
    at("a", 0, {}),
    at("b", 2, {}),
    at("c", 4, { authorId: "other" }),
    at("d", 9, { authorId: "other" }),
    at("e", 11, { authorId: "other" }),
    at("f", 12, {
      membership: {} as NonNullable<ChannelMessage["membership"]>,
    }),
    at("g", 13, {}),
    at("h", 13, { audience: "agents" }),
    at("i", 30, {}),
    at("j", 31, {}),
  ];
  const layout = timelineRowLayout(rows);
  expect(layout).toEqual(
    rows.map((row, index) => {
      const previous = rows[index - 1];
      return {
        day:
          !previous ||
          new Date(previous.createdAt * 1000).toDateString() !==
            new Date(row.createdAt * 1000).toDateString(),
        continues: continuesMessageGroup(previous, row),
      };
    }),
  );
  expect(layout.map(({ day }) => day)).toEqual([
    true,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(layout.map(({ continues }) => continues)).toEqual([
    false,
    true,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
  expect(timelineRowLayout([])).toEqual([]);
});
