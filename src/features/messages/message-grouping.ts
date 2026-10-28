import type { ChannelMessage } from "../relay/contracts";

export function continuesMessageGroup(
  previous: ChannelMessage | undefined,
  current: ChannelMessage,
): boolean {
  return (
    !!previous &&
    !previous.membership &&
    !current.membership &&
    // Legacy output has no workflow ID: one relay signer is not one workflow.
    !previous.workflowOwnerId &&
    !current.workflowOwnerId &&
    !current.sentFromThread &&
    !previous.sentFromThread &&
    previous.channelId === current.channelId &&
    previous.authorId === current.authorId &&
    previous.audience === current.audience &&
    current.createdAt >= previous.createdAt &&
    current.createdAt - previous.createdAt <= 5 * 60 &&
    new Date(previous.createdAt * 1000).toDateString() ===
      new Date(current.createdAt * 1000).toDateString()
  );
}

export type TimelineRowLayout = {
  /** The row starts a local day. */
  day: boolean;
  /** continuesMessageGroup(previous row, this row). */
  continues: boolean;
};

/** Day dividers and stacking for consecutive rows, so a render that keeps its
 * rows can reuse them. */
export function timelineRowLayout(
  rows: readonly ChannelMessage[],
): TimelineRowLayout[] {
  const days = rows.map((row) => new Date(row.createdAt * 1000).toDateString());
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const day = !previous || days[index - 1] !== days[index];
    return { day, continues: !day && continuesMessageGroup(previous, row) };
  });
}
