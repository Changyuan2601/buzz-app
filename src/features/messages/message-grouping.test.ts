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
it("lays out each row as day and group comparisons with its neighbor do", () => {
  const at = (hour: number, minute: number) =>
    new Date(2026, 8, 28, hour, minute).getTime() / 1000;
  const rows: ChannelMessage[] = [
    first,
    { ...first, id: "a", createdAt: first.createdAt + 60 },
    { ...first, id: "b", authorId: "other", createdAt: first.createdAt + 120 },
    { ...first, id: "c", authorId: "other", createdAt: at(23, 58) },
    { ...first, id: "d", authorId: "other", createdAt: at(24, 1) },
    { ...first, id: "e", authorId: "other", createdAt: at(24, 2) },
    { ...first, id: "f", authorId: "other", createdAt: at(24, 1) },
    {
      ...first,
      id: "g",
      authorId: "other",
      membership: { type: "member_joined", actor: "other", target: "other" },
      createdAt: at(24, 3),
    },
  ];
  expect(timelineRowLayout(rows)).toEqual(
    rows.map((row, index) => ({
      day:
        index === 0 ||
        new Date((rows[index - 1]?.createdAt ?? 0) * 1000).toDateString() !==
          new Date(row.createdAt * 1000).toDateString(),
      continues: continuesMessageGroup(rows[index - 1], row),
    })),
  );
  expect(timelineRowLayout([])).toEqual([]);
});
