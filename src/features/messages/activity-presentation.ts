import { useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { requestWork } from "../agents/request-work";
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
  let request = rootId;
  for (const row of rows) {
    if (
      row.audience !== "agents" &&
      !row.membership &&
      agents &&
      !agents.has(row.authorId)
    )
      request = row.id;
    if (request) requests.set(row.id, request);
  }
  const groups: ActivityPresentation[] = [];
  const byRow = new Map<
    string,
    {
      active: boolean;
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
    const lastByAgent = new Map(history.map((row) => [row.authorId, row.id]));
    for (const row of history) {
      const last = lastByAgent.get(row.authorId) === row.id;
      byRow.set(row.id, {
        active: last && working.has(row.authorId),
        motionKey:
          history.length > 1 && last
            ? `${first.id}:${row.authorId}`
            : undefined,
      });
    }
    if (history.length > 1) {
      groups.push({ ...group, done, working: working.size > 0 });
    }
  }
  return { groups, byRow };
}
export function useActivityPresentation(
  rows: readonly ChannelMessage[],
  activity: Activity | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  return activityPresentation(
    rows,
    useActivitySnapshot(activity),
    agents,
    rootId,
  );
}
