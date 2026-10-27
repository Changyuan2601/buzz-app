import type { ChannelMessage } from "../relay/contracts";

export type ActivityGroup = {
  ids: string[];
};

/** Only consecutive agent-only messages on one local day fold together.
 * Human messages, public agent replies and membership notices stay visible. */
export function activityRuns(
  rows: readonly ChannelMessage[],
): ChannelMessage[][] {
  const groups: ChannelMessage[][] = [];
  let group: ChannelMessage[] | undefined;
  let previous: ChannelMessage | undefined;
  for (const row of rows) {
    if (row.audience !== "agents" || row.membership) {
      group = undefined;
    } else {
      if (
        !group ||
        previous?.channelId !== row.channelId ||
        new Date(previous.createdAt * 1000).toDateString() !==
          new Date(row.createdAt * 1000).toDateString()
      ) {
        group = [];
        groups.push(group);
      }
      group.push(row);
    }
    previous = row;
  }
  return groups;
}

export function activityGroups(
  rows: readonly ChannelMessage[],
): ActivityGroup[] {
  return activityRuns(rows)
    .filter((group) => group.length > 1)
    .map((group) => ({ ids: group.map((row) => row.id) }));
}
