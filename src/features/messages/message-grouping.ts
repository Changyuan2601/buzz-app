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
    (previous.audience === current.audience || current.audience === "agents") &&
    current.createdAt >= previous.createdAt &&
    current.createdAt - previous.createdAt <= 5 * 60 &&
    new Date(previous.createdAt * 1000).toDateString() ===
      new Date(current.createdAt * 1000).toDateString()
  );
}

/** Activity belongs inside its surrounding public sender group. */
export function publicMessageNeighbor(
  rows: readonly ChannelMessage[],
  index: number,
  direction: -1 | 1,
) {
  for (
    let next = index + direction;
    next >= 0 && next < rows.length;
    next += direction
  ) {
    const row = rows[next];
    if (row && row.audience !== "agents") return row;
  }
  return undefined;
}
