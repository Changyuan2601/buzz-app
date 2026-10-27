import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";
import { currentActivity } from "../agents/current-activity";
import { useActivityTypingReplacement } from "../conversation/typing-presentation";
const noSubscribe = () => () => {};
const noActivity = () => undefined;
const empty: ReturnType<RelaySession["typing"]["snapshot"]> = [];
const noTyping = () => empty;

/** A current, rendered activity row owns the live signal for its exact scope. */
export function useActivityIndicator(
  session: RelaySession | undefined,
  row: ChannelMessage,
  eligible: boolean,
) {
  const typing = useSyncExternalStore(
    session?.typing?.subscribe ?? noSubscribe,
    session?.typing?.snapshot ?? noTyping,
  );
  const activity = useSyncExternalStore(
    session?.agentActivity?.subscribe ?? noSubscribe,
    session?.agentActivity?.snapshot ?? noActivity,
  );
  const detail = eligible
    ? currentActivity(
        activity,
        typing,
        new Set([row.authorId]),
        row.channelId,
        row.threadRootId,
      ).get(row.authorId)
    : undefined;
  const live = !!detail?.roots.includes(row.threadRootId ?? null);
  useActivityTypingReplacement(
    session
      ? {
          session,
          channelId: row.channelId,
          threadRootId: row.threadRootId,
          pubkey: row.authorId,
        }
      : undefined,
    live,
  );
  return live;
}
