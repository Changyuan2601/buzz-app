// An Agents2 agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's own tabs, then the app's Attention tab, which every
// type shares because the app is what wakes the agent.
import {
  useCallback,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useDraftState } from "../drafts/react";
import type { AgentViewProps } from "./service";
import type { ChannelChoice } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import type { Agent, Agents2, RegisteredAgentType } from "./service";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>` or `agent:attention`; never collides with a host tab. */
  value: `agent:${string}`;
  label: string;
  render(): ReactNode;
}>;

export function agentSections({
  agents2,
  agent,
  type,
  channels,
}: {
  agents2: Agents2;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
}): readonly AgentSection[] {
  return [
    ...(type?.tabs ?? []).map(({ id, title, component: Component }) => ({
      value: `agent:type:${id}` as const,
      label: title,
      render: () => (
        <AgentEditorSection
          Component={Component}
          agent={agent}
          agents2={agents2}
          label={title}
        />
      ),
    })),
    {
      value: "agent:attention",
      label: "Attention",
      render: () => (
        <AttentionPanel
          agent={agent}
          save={(change) => agents2.save(agent.pubkey, change)}
          channels={channels}
        />
      ),
    },
  ];
}

function AgentEditorSection({
  Component,
  agent,
  agents2,
  label,
}: {
  Component: ComponentType<AgentViewProps>;
  agent: Agent;
  agents2: Agents2;
  label: string;
}) {
  const [draft, setDraft] = useState<
    Parameters<NonNullable<AgentViewProps["reportDraft"]>>[0]
  >({ dirty: false, saving: false, discard() {} });
  const reportDraft = useCallback<NonNullable<AgentViewProps["reportDraft"]>>(
    (next) => setDraft(next),
    [],
  );
  useDraftState(`${agent.name}: ${label}`, draft, draft.discard);
  return (
    <Component
      agent={agent}
      save={(config) => agents2.save(agent.pubkey, { config })}
      reportDraft={reportDraft}
    />
  );
}
