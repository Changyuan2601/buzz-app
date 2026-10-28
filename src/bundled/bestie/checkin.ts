import type { RelaySnapshot } from "../../features/relay/service";

type Session = Pick<RelaySnapshot["session"], "read" | "channelWrites">;

/** The name Beekeeper gives every Bestie's heartbeat workflow. */
const HEARTBEAT = "name: Bestie heartbeat\n";

/** Whether Bestie's hourly check-in is on in `channelId`, as the relay holds
 * it: Beekeeper's heartbeat workflow, signed with Bestie's key, is saved
 * there, and Bestie is still a member. The relay turns off an agent's
 * workflows in a channel it leaves, and turning check-in off deletes the
 * workflow. */
export async function readCheckIn(
  session: Session,
  bestie: string,
  channelId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [workflows, home] = await Promise.all([
    session.read(
      [
        {
          kinds: [30620],
          authors: [bestie],
          "#h": [channelId],
          limit: 20,
          consistency: "strong",
        },
      ],
      { fresh: true, signal },
    ),
    session.channelWrites.refreshMembership(channelId),
  ]);
  signal.throwIfAborted();
  return (
    !!home.members?.includes(bestie) &&
    workflows.some(
      (event) =>
        event.kind === 30620 &&
        event.pubkey === bestie &&
        event.tags.some(
          ([name, value]) => name === "h" && value === channelId,
        ) &&
        event.content.startsWith(HEARTBEAT),
    )
  );
}
