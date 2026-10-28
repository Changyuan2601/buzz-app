import { sameLocalDay } from "../../shared/datetime";
import type { ChannelMessage } from "../relay/contracts";

export const RECENT_ACTIVITY_COUNT = 5;

export type ActivityGroup = {
  ids: string[];
};

/** Only consecutive agent-only messages on one local day fold together.
 * Human messages, public agent replies and membership notices stay visible. */
export function activityGroups(
  rows: readonly ChannelMessage[],
): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let group: ActivityGroup | undefined;
  let previous: ChannelMessage | undefined;
  for (const row of rows) {
    if (row.audience !== "agents" || row.membership) {
      group = undefined;
    } else {
      if (
        !group ||
        previous?.channelId !== row.channelId ||
        !sameLocalDay(previous.createdAt, row.createdAt)
      ) {
        group = { ids: [] };
        groups.push(group);
      }
      group.ids.push(row.id);
    }
    previous = row;
  }
  return groups.filter((group) => group.ids.length > RECENT_ACTIVITY_COUNT);
}
