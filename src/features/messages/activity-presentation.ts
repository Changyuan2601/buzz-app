import { useMemo, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { requestWork } from "../agents/request-work";
import { continuesMessageGroup } from "./message-grouping";
import { activityRuns } from "./activity-groups";

type Activity = RelaySession["agentActivity"];
type Snapshot = ReturnType<Activity["snapshot"]>;
type ActivityRun = {
  ids: string[];
  history: ChannelMessage[];
  latest: ChannelMessage;
  participants: string[];
  requestId: string | undefined;
  followingMessage: ChannelMessage | undefined;
};
export type ActivityPresentation = ActivityRun & {
  done: boolean;
  working: boolean;
  standalone?: boolean;
};
const noSubscribe = () => () => {};
const noActivity = () => undefined;
export function useActivitySnapshot(activity: Activity | undefined) {
  return useSyncExternalStore(
    activity?.subscribe ?? noSubscribe,
    activity?.snapshot ?? noActivity,
  );
}

/** Status belongs to the triggering request, never to all work in its thread. */
function activityStatus(group: ActivityRun, snapshot: Snapshot | undefined) {
  const { latest, participants, followingMessage: response, requestId } = group;
  const closed =
    !!response &&
    response.audience !== "agents" &&
    !response.membership &&
    response.channelId === latest.channelId &&
    response.threadRootId === latest.threadRootId &&
    response.createdAt >= latest.createdAt &&
    participants.includes(response.authorId);
  const work = snapshot
    ? requestWork(snapshot, latest.channelId, [
        ...(requestId ? [requestId] : []),
        ...group.ids,
      ])
    : [];
  const done =
    closed ||
    participants.every((agent) =>
      work.some(
        (entry) =>
          entry.agent === agent &&
          (entry.state === "done" || entry.state === "ended"),
      ),
    );
  const working = new Set(
    done
      ? []
      : work.filter((entry) => entry.working).map((entry) => entry.agent),
  );
  return { done, working };
}

/** Shared projection for timeline and thread; hosts own scrolling and disclosure state. */
export function activityPresentation(
  rows: readonly ChannelMessage[],
  snapshot: Snapshot | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  const following = new Map(
    rows.map((row, index) => [row.id, rows[index + 1]]),
  );
  const requests = new Map<string, string>();
  if (rootId) requests.set(rootId, rootId);
  const representedAgents = new Map<string, string[]>();
  let request = rootId;
  for (const row of rows) {
    if (
      row.audience !== "agents" &&
      !row.agentEnvelope &&
      !row.membership &&
      agents &&
      !agents.has(row.authorId)
    )
      request = row.id;
    const parentRequest = requests.get(
      row.replyParentId ?? row.threadRootId ?? "",
    );
    const rowRequest =
      row.agentEnvelope || agents?.has(row.authorId)
        ? (parentRequest ?? request)
        : request;
    if (rowRequest) requests.set(row.id, rowRequest);
    if (
      rowRequest &&
      !row.membership &&
      (row.agentEnvelope || agents?.has(row.authorId))
    ) {
      const represented = representedAgents.get(rowRequest) ?? [];
      if (!represented.includes(row.authorId)) represented.push(row.authorId);
      representedAgents.set(rowRequest, represented);
    }
  }
  const groups: ActivityPresentation[] = [];
  const bubbleAnchors = new Set<string>();
  const byRow = new Map<
    string,
    {
      active: boolean;
      ownsLive: boolean;
      standalone: boolean;
      bubble: boolean;
      motionKey: string | undefined;
    }
  >();
  for (const history of activityRuns(rows)) {
    const first = history[0];
    const latest = history.at(-1);
    if (!first || !latest) continue;
    const participants = [...new Set(history.map((row) => row.authorId))];
    const group: ActivityRun = {
      ids: history.map((row) => row.id),
      history,
      latest,
      participants,
      requestId: requests.get(first.id) ?? first.threadRootId,
      followingMessage: following.get(latest.id),
    };
    const { done, working } = activityStatus(group, snapshot);
    const before = rows[rows.findIndex((row) => row.id === first.id) - 1];
    const anchor =
      done && group.followingMessage?.authorId === first.authorId
        ? group.followingMessage
        : before;
    const standalone =
      !anchor ||
      !!anchor.membership ||
      anchor.audience === "agents" ||
      anchor.authorId !== first.authorId ||
      anchor.threadRootId !== first.threadRootId ||
      (anchor === before && !continuesMessageGroup(anchor, first));
    if (!standalone && !done && before) bubbleAnchors.add(before.id);
    const lastByAgent = new Map(history.map((row) => [row.authorId, row.id]));
    for (const row of history) {
      const last = lastByAgent.get(row.authorId) === row.id;
      byRow.set(row.id, {
        active: last && working.has(row.authorId),
        ownsLive: last && !done && !group.followingMessage,
        standalone: row.id === first.id && standalone,
        bubble: !done || standalone,
        motionKey:
          history.length > 1 && last
            ? `${first.id}:${row.authorId}`
            : undefined,
      });
    }
    if (history.length > 1) {
      groups.push({ ...group, done, working: working.size > 0, standalone });
    }
  }
  const completedReplies = new Set(
    groups.flatMap((group) =>
      group.done &&
      group.followingMessage &&
      !group.followingMessage.membership &&
      group.followingMessage.audience !== "agents" &&
      group.followingMessage.channelId === group.latest.channelId &&
      group.followingMessage.threadRootId === group.latest.threadRootId &&
      group.participants.includes(group.followingMessage.authorId)
        ? [group.followingMessage.id]
        : [],
    ),
  );
  return { groups, byRow, representedAgents, bubbleAnchors, completedReplies };
}
export function useActivityPresentation(
  rows: readonly ChannelMessage[],
  activity: Activity | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  const snapshot = useActivitySnapshot(activity);
  return useMemo(
    () => activityPresentation(rows, snapshot, agents, rootId),
    [rows, snapshot, agents, rootId],
  );
}

/** Keep a finished run's disclosure and expanded history below its reply. */
export function activityDisplayRows<T extends ChannelMessage>(
  rows: readonly T[],
  groups: readonly ActivityPresentation[],
): readonly T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const replies = new Map<string, T>();
  for (const group of groups) {
    const first = group.ids[0];
    const reply = group.followingMessage && byId.get(group.followingMessage.id);
    if (
      first &&
      group.done &&
      reply &&
      !reply.membership &&
      reply.audience !== "agents" &&
      group.participants.includes(reply.authorId) &&
      reply.channelId === group.latest.channelId &&
      reply.threadRootId === group.latest.threadRootId
    )
      replies.set(first, reply);
  }
  if (!replies.size) return rows;
  const moved = new Set([...replies.values()].map((row) => row.id));
  return rows.flatMap((row) => {
    const reply = replies.get(row.id);
    return reply ? [reply, row] : moved.has(row.id) ? [] : [row];
  });
}
