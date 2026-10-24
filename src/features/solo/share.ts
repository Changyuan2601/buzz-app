import {
  sameLabels,
  type ChannelDetailsDraft,
} from "../relay/channel-details-protocol";
import {
  addChannelMember,
  canAddMembers,
  batchAdditionKey,
  canShareSoloChat,
  isBatchAddition,
  knownAgent,
  waitForAddition,
} from "../channel-members/members";
import { archiveHides } from "../relay/identity-archives";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { OutgoingEvent } from "../relay/outbox";
import type { MemberAdditionIntent } from "../channel-members/members";
import { messageLinkParts } from "../messages/message-link-parts";
import { soloChatLinkName } from "./labels";

/** Sharing changes access, never presentation or Solo placement. */
export function canShareConversation(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return (
    canShareSoloChat(session, channel) ||
    !!(
      channel &&
      !channel.huddle &&
      !channel.metadataPending &&
      !channel.cached &&
      !channel.readOnly &&
      !channel.archived &&
      channel.members?.includes(session.viewer ?? "") &&
      canAddMembers(session, channel)
    )
  );
}

export const soloChatLink = (id: string) =>
  `buzz://channel/${encodeURIComponent(id)}`;
export const soloChatLinkMessage = (id: string, name = id.slice(0, 8)) =>
  `[Chat: ${name.replace(/\s+/g, " ").replace(/[\\`[\]*_~<>&|]/g, "\\$&")}](${soloChatLink(id)})`;

/** A saved share keeps its original label even when the chat is renamed. */
function matchesSoloChatLink(content: string, id: string) {
  const parts = messageLinkParts(content).filter((part) => part.text !== "");
  return (
    parts.length === 1 &&
    parts[0]?.url === soloChatLink(id) &&
    /^(?:Session|Chat)(?:: | · )/.test(parts[0]?.label ?? "")
  );
}

/** Outbox can finish a delivered link even after its in-process share was reset. */
export function isSoloChatLinkReceipt(item: OutgoingEvent) {
  const match = /^solo-share-link:([^:]+):([^:]+)$/.exec(
    item.recovery?.key ?? "",
  );
  return !!(
    match?.[1] &&
    match[2] &&
    item.recovery?.value === "1" &&
    item.event.kind === 9 &&
    matchesSoloChatLink(item.event.content, match[1]) &&
    item.event.tags.some(([name, value]) => name === "h" && value === match[2])
  );
}

/** Exact selected people are grants to the chat, not the destination or its parent.
 * Opportunistic: everyone is tried and per-person failures are returned, not
 * thrown. Abort, lost add rights and a throwing `beforeDispatch` or
 * `onConfirmed` stop the rest. Fresh people go in one batch first; anyone it
 * didn't add gets a single addition, which also names why they failed. */
export async function grantSoloChatAccess(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: Map<string, MemberAdditionIntent>,
  signal: AbortSignal,
  onConfirmed: (key: string) => void,
  includeAgents = false,
  soloParticipant = true,
  skipArchived = false,
  beforeDispatch?: () => void,
): Promise<{ key: string; error: string }[]> {
  if (people.length > 100 || new Set(people).size !== people.length)
    throw new Error("Choose at most 100 distinct recipients.");
  const added = await addAtOnce(
    session,
    channelId,
    people,
    intents,
    signal,
    includeAgents,
    soloParticipant,
    beforeDispatch,
  );
  for (const key of added) onConfirmed(key);
  const failed: { key: string; error: string }[] = [];
  let stopped = false;
  const dispatch = () => {
    try {
      beforeDispatch?.();
    } catch (reason) {
      stopped = true;
      throw reason;
    }
  };
  for (const key of people) {
    signal.throwIfAborted();
    if (added.includes(key)) continue;
    // Channel audiences omit archived identities; direct selections still fail explicitly.
    if (skipArchived && archiveHides(session.archives, key, session.viewer))
      continue;
    const intent = intents.get(key) ?? {};
    intents.set(key, intent);
    try {
      await addChannelMember(
        session,
        channelId,
        key,
        signal,
        intent,
        session.outbox,
        soloParticipant,
        includeAgents,
        dispatch,
      );
    } catch (reason) {
      signal.throwIfAborted();
      // Losing the right to add anyone is not a per-person failure.
      const chat =
        session.channels
          .list()
          .channels.find((item) => item.id === channelId) ??
        session.channels.get?.(channelId);
      if (
        stopped ||
        !(soloParticipant
          ? canShareSoloChat(session, chat)
          : canAddMembers(session, chat))
      )
        throw reason;
      failed.push({
        key,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      continue;
    }
    onConfirmed(key);
  }
  return failed;
}

/** One kind 9000 naming every fresh person, when there are several. A relay
 * without batch support adds only the first `p` and reads only the event's
 * `role`, so humans go first and the roster decides who was added. */
async function addAtOnce(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: Map<string, MemberAdditionIntent>,
  signal: AbortSignal,
  includeAgents: boolean,
  soloParticipant: boolean,
  beforeDispatch?: () => void,
) {
  const outbox = session.outbox;
  const allowed = () => {
    const chat =
      session.channels.list().channels.find((item) => item.id === channelId) ??
      session.channels.get?.(channelId);
    return soloParticipant
      ? canShareSoloChat(session, chat)
      : canAddMembers(session, chat);
  };
  if (people.length < 2 || !outbox || !allowed()) return [];
  // Best effort: anything short of an abort or a stop leaves the rest to single adds.
  const attempt = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  };
  const before = await attempt(async () => {
    await outbox.ready();
    return session.channelWrites.refreshMembership(channelId);
  });
  signal.throwIfAborted();
  if (!before) return [];
  // People with an addition already under way keep it. A batch left by a
  // reload is settled here; the roster decides who it added.
  const pending = new Set<string>();
  for (const { event, acknowledged, recovery } of outbox.snapshot()) {
    if (
      acknowledged ||
      event.kind !== 9000 ||
      !event.tags.some(([tag, value]) => tag === "h" && value === channelId)
    )
      continue;
    if (isBatchAddition(recovery))
      await attempt(() => outbox.acknowledge(event.id));
    else
      for (const [tag, key] of event.tags)
        if (tag === "p" && key) pending.add(key);
  }
  // Anyone a single addition would refuse stays out, so it reports why.
  const fresh = people.filter((key) => {
    const intent = intents.get(key);
    return (
      /^[0-9a-f]{64}$/.test(key) &&
      !intent?.id &&
      !intent?.confirmed &&
      !intent?.dismissed &&
      !before.members?.includes(key) &&
      !pending.has(key) &&
      !archiveHides(session.archives, key, session.viewer) &&
      (includeAgents || !soloParticipant || !knownAgent(session, key))
    );
  });
  if (fresh.length < 2 || !allowed()) return [];
  const agents = new Set(fresh.filter((key) => knownAgent(session, key)));
  const ordered = [
    ...fresh.filter((key) => !agents.has(key)),
    ...fresh.filter((key) => agents.has(key)),
  ];
  beforeDispatch?.();
  const id = await attempt(async () =>
    outbox.send(
      {
        kind: 9000,
        content: "",
        tags: [
          ["h", channelId],
          ...ordered.map((key) =>
            agents.has(key) ? ["p", key, "bot"] : ["p", key],
          ),
          ...(agents.size === ordered.length ? [["role", "bot"]] : []),
        ],
      },
      { key: batchAdditionKey(), value: "1" },
    ),
  );
  if (!id) return [];
  try {
    // A refusal or unknown result still leaves the roster to decide.
    await attempt(() => waitForAddition(outbox, id, signal));
    const after = await attempt(() =>
      session.channelWrites.refreshMembership(channelId),
    );
    return ordered.filter((key) => {
      if (!after?.members?.includes(key)) return false;
      const intent = intents.get(key) ?? {};
      intent.confirmed = true;
      intents.set(key, intent);
      return true;
    });
  } finally {
    // Settled: a single addition for anyone missing must not resume this event.
    await outbox.acknowledge(id).catch(() => {});
  }
}

/** One line naming who a partial share missed; access for the rest stands. */
export function accessFailureNotice(
  failed: readonly { key: string }[],
  name: (key: string) => string,
) {
  const shown = failed.slice(0, 3).map(({ key }) => name(key));
  const more = failed.length - shown.length;
  return `Couldn’t give ${shown.join(", ")}${more ? ` and ${more} more` : ""} access to the chat.`;
}

/** Capture validated destination keys, including oversized rosters. The share
 * attempt freezes them before its combined 100-recipient admission check, so a
 * retry cannot adopt a smaller or changed audience without explicit Start over. */
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
    destination.huddle ||
    destination.metadataPending ||
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
  if (keys.some((key) => !/^[0-9a-f]{64}$/.test(key)))
    throw new Error("Destination membership contains an invalid identity.");
  return keys.filter(
    (key) => !archiveHides(session.archives, key, session.viewer),
  );
}

/** Recheck the exact destination after grants: confirmed additions do not imply
 * the viewer can still post to another channel. The Outbox owns actual delivery. */
export async function publishSoloChatLink(
  session: RelaySession,
  sourceId: string,
  destinationId: string,
  previousId: string | undefined,
  signal: AbortSignal,
  onQueued: (id: string) => void,
) {
  const source = await session.channelWrites.refreshMembership(sourceId);
  const destination =
    await session.channelWrites.refreshMembership(destinationId);
  const eligible = (channel: ChannelSummary, soloChat: boolean) =>
    !!session.viewer &&
    !channel.huddle &&
    !channel.metadataPending &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived &&
    !!channel.members?.includes(session.viewer) &&
    (soloChat
      ? canShareConversation(session, channel)
      : channel.channelType === "stream" || channel.channelType === "forum");
  if (!eligible(source, true) || !eligible(destination, false))
    throw new Error("Chat or destination access changed. Refresh and retry.");
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
    throw new Error("Chat or destination access changed. Refresh and retry.");
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
          matchesSoloChatLink(event.content, sourceId) &&
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
      !matchesSoloChatLink(existing.event.content, sourceId) ||
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
    key: `solo-share-link:${sourceId}:${destinationId}`,
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
      soloChatLinkMessage(sourceId, soloChatLinkName(source)),
      [],
      [],
      recovery,
      [],
      {},
      [sourceId],
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
    value.ttlSeconds === draft.ttlSeconds &&
    (draft.labels === undefined ||
      sameLabels(value.labels ?? [], draft.labels));
  const pending = details.snapshot(id);
  if (pending) {
    if (!matches(pending.draft) || pending.status !== "unconfirmed")
      throw new Error(
        "Finish the existing channel details change before continuing.",
      );
    await details.check(id, signal);
  }
  const base = await details.load(id, signal);
  if (!base.canEdit)
    throw new Error("You no longer have permission to edit this conversation.");
  if (!matches(base)) {
    if (
      base.name !== expected.name ||
      base.description !== expected.description ||
      base.visibility !== expected.visibility ||
      base.ttlSeconds !== expected.ttlSeconds ||
      (draft.labels !== undefined &&
        !sameLabels(base.labels ?? [], expected.labels ?? []))
    )
      throw new Error(
        "Channel settings changed. Reload details before continuing.",
      );
    await details.save(base, draft, signal);
  }
}
