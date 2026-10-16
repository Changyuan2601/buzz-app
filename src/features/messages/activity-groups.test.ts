import { expect, it } from "vitest";
import { activityGroups } from "./activity-groups";
import type { ChannelMessage } from "../relay/contracts";

const activity = (
  id: string,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id,
  channelId: "solo",
  authorId: "agent",
  audience: "agents",
  createdAt: 100,
  content: id,
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
  ...patch,
});
const run = (prefix: string, count = 6) =>
  Array.from({ length: count }, (_, index) => activity(`${prefix}${index}`));

it("folds only runs longer than five and includes different agents in a run", () => {
  expect(activityGroups(run("a", 5))).toEqual([]);
  const rows = run("a");
  rows[2] = activity("other-agent", { authorId: "other" });
  expect(activityGroups(rows)).toEqual([{ ids: rows.map((row) => row.id) }]);
});

it.each(["human", "agent", "membership"])(
  "keeps ordinary messages and membership notices outside groups: %s",
  (kind) => {
    const before = run("before"),
      after = run("after");
    const { audience: _audience, ...ordinary } = activity("separator");
    const separator =
      kind === "membership"
        ? {
            ...ordinary,
            membership: {
              type: "member_joined" as const,
              actor: "human",
              target: "human",
            },
          }
        : { ...ordinary, authorId: kind };
    expect(activityGroups([...before, separator, ...after])).toEqual([
      { ids: before.map((row) => row.id) },
      { ids: after.map((row) => row.id) },
    ]);
  },
);

it("splits groups across local days and channels", () => {
  const today = run("today");
  const tomorrow = run("tomorrow").map((row) => ({
    ...row,
    createdAt: 100 + 86400,
  }));
  const elsewhere = run("elsewhere").map((row) => ({
    ...row,
    channelId: "other",
  }));
  expect(activityGroups([...today, ...tomorrow, ...elsewhere])).toEqual(
    [today, tomorrow, elsewhere].map((rows) => ({
      ids: rows.map((row) => row.id),
    })),
  );
});
