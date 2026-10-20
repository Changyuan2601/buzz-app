// The turns a remote agent published to its owner over the relay this session.
import {
  type ComponentType,
  type ReactNode,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import { useRelayConnection } from "../../../features/relay/react";
import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import { activityTranscript } from "../../../features/agents/activity-transcript";
import { ActivityTranscript } from "../../../features/agents/ActivityTranscript";
import type {
  Agent,
  AgentConversation,
  AgentViewProps,
} from "../../../features/agents/service";

export type AgentActivity = RelaySession["agentActivity"];

const UNAVAILABLE = "Activity isn't available here.";

export function createActivityTab(
  relay: RelayData,
): ComponentType<AgentViewProps> {
  return function PublishedActivity({ agent, conversation }) {
    const connection = useRelayConnection(relay);
    return (
      <ActivityPanel
        agent={agent}
        conversation={conversation}
        activity={
          connection.status === "ready"
            ? connection.session.agentActivity
            : undefined
        }
      />
    );
  };
}

export function ActivityPanel({
  agent,
  activity,
  conversation,
}: {
  agent: Agent;
  /** Absent while the owner's session connects. */
  activity: AgentActivity | undefined;
  /** Where it was opened from; its turns are shown until widened to all. */
  conversation?: AgentConversation | undefined;
}) {
  if (!activity) return <Note>Activity shows once Buzz is connected.</Note>;
  return (
    <ActivityFeed
      agent={agent}
      activity={activity}
      conversation={conversation}
    />
  );
}

function ActivityFeed({
  agent,
  activity,
  conversation,
}: {
  agent: Agent;
  activity: AgentActivity;
  conversation: AgentConversation | undefined;
}) {
  // The Agent Activity plugin owns the feed's lease; this only reads it.
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const [everywhere, setEverywhere] = useState(false);
  const scoped = !!conversation && !everywhere;
  const channelId = scoped ? conversation.channelId : undefined;
  const threadRootId = scoped ? conversation.rootId : undefined;
  const transcript = useMemo(
    () =>
      activityTranscript(
        snapshot.records.filter((record) => record.agent === agent.pubkey),
        { agent: agent.pubkey, channelId, threadRootId },
      ),
    [snapshot.records, agent.pubkey, channelId, threadRootId],
  );
  if (snapshot.status === "unavailable") return <Note>{UNAVAILABLE}</Note>;
  if (snapshot.status === "disabled")
    return (
      <Note>Turn on Agent Activity in Settings → Plugins to see activity.</Note>
    );
  if (!transcript.turns.length && snapshot.status === "connecting")
    return <Note>Connecting to the live feed…</Note>;
  const state = new Map(
    snapshot.turns
      .filter((turn) => turn.agent === agent.pubkey)
      .map((turn) => [turn.turnId, turn.state]),
  );
  return (
    <ActivityTranscript
      transcript={transcript}
      agentName={agent.name}
      state={(turnId) => state.get(turnId)}
      before={
        <>
          <Note>Shows what the agent did while Buzz has been open.</Note>
          {snapshot.status === "interrupted" && (
            <Note>
              The live feed was interrupted; it reconnects on its own.
            </Note>
          )}
          {snapshot.trimmed > 0 && (
            <Note>Older activity was dropped to save memory.</Note>
          )}
          {conversation && (
            <div className="flex">
              <Button size="compact" onClick={() => setEverywhere(!everywhere)}>
                {everywhere
                  ? "Show this conversation"
                  : "Show all conversations"}
              </Button>
            </div>
          )}
          {scoped && transcript.unknownThread > 0 && (
            <Note>
              {transcript.unknownThread} turn(s) with an unknown thread show
              only under all conversations.
            </Note>
          )}
        </>
      }
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-body-sm text-secondary">
      {children}
    </p>
  );
}
