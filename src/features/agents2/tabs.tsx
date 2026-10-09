// An Agents2 agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's own tabs, then the app's Attention tab, which every
// type shares because the app is what wakes the agent.
import type { ReactNode } from "react";
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
        <Component
          agent={agent}
          save={(config) => agents2.save(agent.pubkey, { config })}
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
