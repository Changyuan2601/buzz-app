import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { continuesMessageGroup, sameLocalDay } from "./message-grouping";

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
it("compares local calendar days exactly as toDateString does", () => {
  const sameString = (a: number, b: number) =>
    new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  // Every local midnight of two years, including daylight-saving transitions,
  // across gaps that cross days, months and years.
  for (let day = 0; day < 731; day++) {
    const midnight = new Date(2025, 0, 1 + day).getTime() / 1000;
    for (const offset of [-86_400, -3_601, -300, -1, 0, 1, 299])
      for (const gap of [0, 1, 300, 3_600, 86_399, 86_400, 2_678_400]) {
        const previous = midnight + offset;
        expect(sameLocalDay(previous, previous + gap)).toBe(
          sameString(previous, previous + gap),
        );
      }
  }
  // Out-of-range times are all "Invalid Date".
  for (const [a, b] of [
    [9e15, 9e15 + 1],
    [9e15, 0],
    [0, -9e15],
  ] as const)
    expect(sameLocalDay(a, b)).toBe(sameString(a, b));
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
