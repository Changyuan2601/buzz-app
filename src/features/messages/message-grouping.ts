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
    sameLocalDay(previous.createdAt, current.createdAt)
  );
}

/** `toDateString()` equality of two Unix times, without formatting either.
 * Timelines ask this for every row on every render. */
export function sameLocalDay(a: number, b: number): boolean {
  const first = new Date(a * 1000);
  const second = new Date(b * 1000);
  return (
    (first.getDate() === second.getDate() &&
      first.getMonth() === second.getMonth() &&
      first.getFullYear() === second.getFullYear()) ||
    (Number.isNaN(first.getTime()) && Number.isNaN(second.getTime()))
  );
}
