import type { ChannelDetailsDraft } from "../relay/channel-details-protocol";
import { addChannelMember, canShareSession } from "../channel-members/members";
import { archiveHides } from "../relay/identity-archives";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { OutgoingEvent } from "../relay/outbox";
import type { MemberAdditionIntent } from "../channel-members/members";

export const sessionLink = (id: string) =>
  `buzz://channel/${encodeURIComponent(id)}`;
export const sessionLinkMessage = (id: string) =>
  `[Session · ${id.slice(0, 8)}](${sessionLink(id)})`;

/** Outbox can finish a delivered link even after its in-process share was reset. */
export function isSessionLinkReceipt(item: OutgoingEvent) {
  const match = /^session-share-link:([^:]+):([^:]+)$/.exec(
    item.recovery?.key ?? "",
  );
  return !!(
    match?.[1] &&
    match[2] &&
    item.recovery?.value === "1" &&
    item.event.kind === 9 &&
    item.event.content === sessionLinkMessage(match[1]) &&
    item.event.tags.some(([name, value]) => name === "h" && value === match[2])
  );
}

/** Exact selected people are grants to the session, not the destination or its parent. */
export async function grantSessionAccess(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: Map<string, MemberAdditionIntent>,
  signal: AbortSignal,
  onConfirmed: (key: string) => void,
  includeAgents = false,
  sessionParticipant = true,
) {
  if (people.length > 100 || new Set(people).size !== people.length)
    throw new Error("Choose at most 100 distinct recipients.");
  for (const key of people) {
    signal.throwIfAborted();
    const intent = intents.get(key) ?? {};
    intents.set(key, intent);
    await addChannelMember(
      session,
      channelId,
      key,
      signal,
      intent,
      session.outbox,
      sessionParticipant,
      includeAgents,
    );
    onConfirmed(key);
  }
}

/** Capture one relay-confirmed destination roster, not the session or a cached
 * chooser list. A retry uses the frozen keys and never expands to late joins. */
export async function destinationShareAudience(
  session: RelaySession,
  destinationId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const fresh = await session.channels.refreshRoster?.(destinationId, {
    consistency: "strong",
    signal,
  });
  signal.throwIfAborted();
  const destination = session.channels
    .list()
    .channels.find((item) => item.id === destinationId);
  if (
    !fresh ||
    !destination ||
    destination.cached ||
    destination.archived ||
    destination.readOnly ||
    !destination.members?.includes(session.viewer ?? "") ||
    !["stream", "forum"].includes(destination.channelType ?? "")
  )
    throw new Error(
      "Destination membership could not be confirmed. Retry to share.",
    );
  const keys = [
    ...new Set(destination.members.filter((key) => key !== session.viewer)),
  ];
  if (keys.length > 100)
    throw new Error(
      "This channel has more than 100 recipients. Choose selected people instead.",
    );
  if (keys.some((key) => !/^[0-9a-f]{64}$/.test(key)))
    throw new Error("Destination membership contains an invalid identity.");
  if (keys.some((key) => archiveHides(session.archives, key, session.viewer)))
    throw new Error(
      "A destination member is archived. Choose selected people instead.",
    );
  return keys;
}

/** Recheck the exact destination after grants: confirmed additions do not imply
 * the viewer can still post to another channel. The Outbox owns actual delivery. */
export async function publishSessionLink(
  session: RelaySession,
  sourceId: string,
  destinationId: string,
  previousId: string | undefined,
  signal: AbortSignal,
  onQueued: (id: string) => void,
) {
  const source = await session.workSessions.refreshMembership(sourceId);
  const destination =
    await session.workSessions.refreshMembership(destinationId);
  const eligible = (channel: ChannelSummary, sessionChannel: boolean) =>
    !!session.viewer &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived &&
    !!channel.members?.includes(session.viewer) &&
    (sessionChannel
      ? canShareSession(session, channel)
      : channel.channelType === "stream" || channel.channelType === "forum");
  if (!eligible(source, true) || !eligible(destination, false))
    throw new Error(
      "Session or destination access changed. Refresh and retry.",
    );
  signal.throwIfAborted();
  const outbox = session.outbox;
  if (!outbox?.supports(9)) throw new Error("Message posting is unavailable.");
  await outbox.ready();
  signal.throwIfAborted();
  if (
    !eligible(
      session.channels.list().channels.find((item) => item.id === sourceId) ??
        source,
      true,
    ) ||
    !eligible(
      session.channels
        .list()
        .channels.find((item) => item.id === destinationId) ?? destination,
      false,
    )
  )
    throw new Error(
      "Session or destination access changed. Refresh and retry.",
    );
  const existing = previousId
    ? outbox.snapshot().find((item) => item.event.id === previousId)
    : undefined;
  if (previousId && !existing) {
    const found = await session.read(
      [{ ids: [previousId], limit: 1, consistency: "strong" }],
      { signal, fresh: true },
    );
    if (
      found.some(
        (event) =>
          event.id === previousId &&
          event.kind === 9 &&
          event.pubkey === session.viewer &&
          event.content === sessionLinkMessage(sourceId) &&
          event.tags.some(
            ([name, value]) => name === "h" && value === destinationId,
          ),
      )
    )
      return previousId;
    throw new Error(
      "Link delivery is unconfirmed. Check Outbox and the channel before posting again.",
    );
  }
  if (
    existing &&
    (existing.event.kind !== 9 ||
      existing.event.pubkey !== session.viewer ||
      existing.event.content !== sessionLinkMessage(sourceId) ||
      !existing.event.tags.some(
        ([name, value]) => name === "h" && value === destinationId,
      ))
  )
    throw new Error(
      "Saved link does not match this share. Check Outbox before retrying.",
    );
  if (existing?.delivery === "accepted" || existing?.delivery === "seen") {
    await outbox.acknowledge(existing.event.id);
    return existing.event.id;
  }
  const recovery = {
    key: `session-share-link:${sourceId}:${destinationId}`,
    value: "1",
  };
  // A submitted operation saved before this caller owned recovery can still be
  // in flight. Protect its exact ID before an echo moves it out of snapshot().
  if (existing && !existing.recovery)
    await outbox.recover(existing.event.id, recovery);
  // Keep this one link operation visible when a relay echo precedes its HTTP
  // receipt. Ordinary messages leave Outbox.snapshot() on echo; this caller
  // needs terminal evidence before releasing its submitted share attempt.
  const id =
    existing?.event.id ??
    session.messages.send(
      destinationId,
      sessionLinkMessage(sourceId),
      [],
      [],
      recovery,
    );
  onQueued(id);
  if (existing?.delivery === "failed" || existing?.delivery === "unknown")
    outbox.retry(id);
  await new Promise<void>((resolve, reject) => {
    let stop = () => {};
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stop();
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () =>
      finish(
        new Error(
          "Sharing interrupted. Check Outbox and the channel before retrying.",
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Link delivery is unconfirmed. Check Outbox before retrying.",
          ),
        ),
      15_000,
    );
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      if (!item)
        finish(
          new Error(
            "Link delivery is unconfirmed. Check the channel before retrying.",
          ),
        );
      else if (item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery === "failed" || item.delivery === "unknown")
        finish(
          new Error(
            item.error ??
              "Link delivery is unconfirmed. Retry the saved message.",
          ),
        );
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
  await outbox.acknowledge(id);
  return id;
}

/** Promote in place through the existing signed details owner. A retry checks an
 * uncertain save; it never republishes it or resets an unchanged cleanup deadline. */
export async function applySharedChannelDetails(
  session: RelaySession,
  id: string,
  draft: ChannelDetailsDraft,
  expected: ChannelDetailsDraft,
  signal: AbortSignal,
) {
  const details = session.channelDetails;
  const matches = (value: ChannelDetailsDraft) =>
    value.name === draft.name &&
    value.description === draft.description &&
    value.visibility === draft.visibility &&
    value.ttlSeconds === draft.ttlSeconds;
  const pending = details.snapshot(id);
  if (pending) {
    if (!matches(pending.draft) || pending.status !== "unconfirmed")
      throw new Error(
        "Finish the existing channel details change before sharing.",
      );
    await details.check(id, signal);
  }
  const base = await details.load(id, signal);
  if (!base.canEdit)
    throw new Error(
      "You no longer have permission to share this conversation.",
    );
  if (!matches(base)) {
    if (
      base.name !== expected.name ||
      base.description !== expected.description ||
      base.visibility !== expected.visibility ||
      base.ttlSeconds !== expected.ttlSeconds
    )
      throw new Error(
        "Channel settings changed after sharing. Check them in Messages before continuing.",
      );
    await details.save(base, draft, signal);
  }
}
