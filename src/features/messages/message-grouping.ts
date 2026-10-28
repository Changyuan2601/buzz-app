import type { ChannelMessage } from "../relay/contracts";

const localDay = (message: ChannelMessage) =>
  new Date(message.createdAt * 1000).toDateString();

function continuesOnDay(previous: ChannelMessage, current: ChannelMessage) {
  return (
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
    current.createdAt - previous.createdAt <= 5 * 60
  );
}

export function continuesMessageGroup(
  previous: ChannelMessage | undefined,
  current: ChannelMessage,
): boolean {
  return (
    !!previous &&
    continuesOnDay(previous, current) &&
    localDay(previous) === localDay(current)
  );
}

/** Per row: whether it starts a local day, and whether it continues the
 * previous row's group. Each row's local day is converted once. */
export function timelineRowLayout(
  rows: readonly ChannelMessage[],
): { day: boolean; continues: boolean }[] {
  const days = rows.map(localDay);
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const day = !previous || days[index - 1] !== days[index];
    return {
      day,
      continues: !!previous && !day && continuesOnDay(previous, row),
    };
  });
}
