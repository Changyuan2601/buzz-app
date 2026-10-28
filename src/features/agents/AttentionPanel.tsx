// The device-local runtime control. Agent Attention owns Interests and watches.
import { useState } from "react";
import {
  AgentCommunityScope,
  useAgentScopeCommunity,
  type AgentScopeReader,
} from "./AgentCommunityScope";
import type { CommunityReader } from "../communities/service";
import { AtIcon, EyeIcon, TimerIcon } from "../../shared/design-system/icons";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import {
  attentionOf,
  describeWatch,
  plural,
  type ChannelChoice,
  type Watch,
} from "./attention";
import type { Agent, AgentChange } from "./service";

/** The device-local runtime switch. */
type Save = (change: AgentChange) => Promise<void>;

const watchIcon = (watch: Watch) =>
  watch.type === "timer" ? (
    <TimerIcon size={14} aria-hidden="true" />
  ) : (
    <EyeIcon size={14} aria-hidden="true" />
  );

/** Read-only: what wakes the agent, one line each. For glances like the peek. */
export function AttentionSummary({
  agent,
  channels = [],
}: {
  agent: Agent;
  channels?: readonly ChannelChoice[];
}) {
  const { watches } = attentionOf(agent.attention);
  const on = watches.filter((object) => object.value.enabled);
  const paused = watches.length - on.length;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0 text-body-sm">
      <li className="flex items-center gap-2">
        <AtIcon size={14} aria-hidden="true" /> Mentions
      </li>
      {on.map((object) => (
        <li key={object.slug} className="flex min-w-0 items-center gap-2">
          {watchIcon(object.value)}
          <span className="truncate">
            {describeWatch(object.value, channels)}
          </span>
        </li>
      ))}
      {paused > 0 && (
        <li className="text-secondary">{plural(paused, "paused watch")}</li>
      )}
    </ul>
  );
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}
const Problem = ({ error }: { error: string }) =>
  error ? (
    <p role="alert" className="m-0 text-body-sm text-danger">
      {error}
    </p>
  ) : null;

export function AttentionPanel({
  agent,
  save,
  communities,
  agents,
}: {
  agent: Agent;
  save: Save;
  communities?: CommunityReader | undefined;
  agents: AgentScopeReader;
}) {
  const community = useAgentScopeCommunity(agent, agents, communities);
  const switched = useAction();
  return (
    <div className="grid gap-4">
      <SettingsGroup>
        <PreferenceRow
          icon={<AtIcon size={16} />}
          title="Mentions"
          subtitle="Responds when someone @mentions it. Always on."
        />
        <PreferenceRow
          icon={<EyeIcon size={16} />}
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Attention on this device
              <AgentCommunityScope community={community} scope="Attention" />
            </span>
          }
          subtitle={
            <>
              Let this device run the agent’s watches. Turning this off also
              pauses its Attention tools here. Mentions still work.
              <Problem error={switched.error} />
            </>
          }
          trailing={
            <Switch
              aria-label="Attention on this device"
              checked={agent.attentionEnabled}
              disabled={switched.pending}
              onCheckedChange={(attentionEnabled) =>
                void switched.run(() => save({ attentionEnabled }))
              }
            />
          }
        />
      </SettingsGroup>
      <p className="m-0 text-body-sm text-secondary">
        Manage Interests and watches in Agent Attention.
      </p>
    </div>
  );
}
