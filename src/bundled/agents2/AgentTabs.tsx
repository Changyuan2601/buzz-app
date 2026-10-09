import { useState } from "react";
import type { ChannelChoice } from "../../features/agents2/attention";
import type {
  Agent,
  Agents2,
  RegisteredAgentType,
} from "../../features/agents2/service";
import { agentSections } from "../../features/agents2/tabs";
import { Tabs } from "../../shared/design-system/ui/Tabs";

/** An agent's sections as tabs, opening on the first. */
export function AgentTabs(props: {
  agents2: Agents2;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
}) {
  const sections = agentSections(props);
  const [tab, setTab] = useState<string>(sections[0]?.value ?? "");
  const selected =
    sections.find((section) => section.value === tab) ?? sections.at(-1);
  return (
    <Tabs
      value={selected?.value ?? ""}
      onValueChange={setTab}
      items={sections.map(({ value, label }) => ({ value, label }))}
      label={`${props.agent.name} sections`}
      variant="panel"
      renderPanel={(value) => (
        <div className="pt-4">
          {sections.find((section) => section.value === value)?.render()}
        </div>
      )}
    />
  );
}
