import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../relay/channel-details-protocol";
import { trackMemberAdditionReceipts } from "../channel-members/operations";
import type { RelaySession } from "../relay/session";
import type { MemberAdditionIntent } from "../channel-members/members";

export type ShareIntent = Readonly<{
  destination: string;
  audience: "everyone" | "selected";
  name?: string;
  visibility?: "private" | "open";
  details?: ChannelDetailsDraft;
  detailsBase?: ChannelDetails;
  channelPeople: readonly string[];
  sessionPeople: readonly string[];
}>;
export type ShareAttempt = {
  intent: ShareIntent;
  /** A created channel stays the same destination on every retry. */
  created?: string;
  detailsApplied?: boolean;
  messageId?: string;
  grants: Map<string, MemberAdditionIntent>;
  /** Frozen after a fresh destination roster read, before any session grants. */
  audienceKeys?: readonly string[];
  /** Two mounted entry points must never enqueue competing link operations. */
  running?: boolean;
  stopReceipts?: (() => void) | undefined;
};

// A submitted attempt is owned by this relay session, not its dialog. The
// Outbox/channelCreation/memberAdditions remain the durable operation owners.
const attempts = new WeakMap<RelaySession, Map<string, ShareAttempt>>();
export function sessionShareAttempt(session: RelaySession, sourceId: string) {
  return attempts.get(session)?.get(sourceId);
}
export function beginSessionShare(
  session: RelaySession,
  sourceId: string,
  intent: ShareIntent,
) {
  let bySource = attempts.get(session);
  if (!bySource) {
    bySource = new Map();
    attempts.set(session, bySource);
  }
  const existing = bySource.get(sourceId);
  if (existing) return existing;
  const attempt: ShareAttempt = {
    intent,
    grants: new Map<string, MemberAdditionIntent>(),
  };
  attempt.stopReceipts = trackMemberAdditionReceipts(session.outbox, () =>
    attempt.grants.values(),
  );
  bySource.set(sourceId, attempt);
  return attempt;
}
export function finishSessionShare(session: RelaySession, sourceId: string) {
  sessionShareAttempt(session, sourceId)?.stopReceipts?.();
  attempts.get(session)?.delete(sourceId);
}
