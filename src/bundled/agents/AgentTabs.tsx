import { useId, useState, type ReactNode } from "react";
import type { ChannelChoice } from "../../features/agents/attention";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  AgentsClient,
  AgentTypeView,
} from "../../features/agents/service";
import type { AgentMemories } from "../../features/agents/MemoryPanel";
import { agentSections } from "../../features/agents/tabs";
import { Tabs } from "../../shared/design-system/ui/Tabs";

/** An agent's sections as tabs, opening on the first. */
export function AgentTabs(props: {
  agents: AgentsClient;
  agent: Agent;
  type: AgentTypeView | undefined;
  channels: readonly ChannelChoice[];
  settingsHost: AgentSettingsHost;
  memories: AgentMemories | undefined;
  settingsContent: ReactNode;
  conversation?: AgentConversation | undefined;
  initialActivity?: boolean | undefined;
}) {
  const split = props.type?.tabs?.some(
    (section) => section.role === "settings" && section.splitSettings,
  );
  const supplied = agentSections({
    ...props,
    ...(split ? { settingsSection: "identity" as const } : {}),
  });
  const identity = supplied.find(
    (section) => section.value === "agent:settings",
  );
  const sections = [
    ...(identity ? [{ ...identity, label: "Identity" }] : []),
    ...supplied.filter((section) => section.value.startsWith("agent:type:")),
    ...supplied.filter((section) => section.value === "agent:memory"),
    ...supplied.filter((section) => section.value === "agent:attention"),
    ...supplied.filter((section) => section.value === "agent:activity"),
    {
      value: "agent:management",
      label: "Settings",
      render: () => props.settingsContent,
    },
  ];
  const [tab, setTab] = useState<string>(
    props.initialActivity ? "agent:activity" : (sections[0]?.value ?? ""),
  );
  const [visited, setVisited] = useState(() => new Set([tab]));
  const panelPrefix = useId();
  const selected =
    sections.find((section) => section.value === tab) ?? sections[0];
  const settingsSelected =
    selected?.value === "agent:settings" ||
    selected?.value === "agent:management";
  // One retained provider form owns both halves of the draft and its save action.
  const settings = split
    ? agentSections({
        ...props,
        settingsSection:
          selected?.value === "agent:management" ? "runtime" : "identity",
        settingsContent: props.settingsContent,
      }).find((section) => section.value === "agent:settings")
    : undefined;
  const settingsValue =
    selected?.value === "agent:management"
      ? "agent:management"
      : "agent:settings";
  const panelId = (value: string) => `${panelPrefix}-${value}`;
  return (
    <>
      <Tabs
        value={selected?.value ?? ""}
        onValueChange={(value) => {
          setVisited((previous) => new Set([...previous, tab, value]));
          setTab(value);
        }}
        items={sections.map(({ value, label }) => ({
          value,
          label,
          panelId: panelId(value),
        }))}
        label={`${props.agent.name} sections`}
        variant="panel"
      />
      {settings && (
        <div
          role="tabpanel"
          id={panelId(settingsValue)}
          aria-labelledby={`${panelId(settingsValue)}-tab`}
          hidden={!settingsSelected}
        >
          <div className="grid gap-6 pt-4">{settings.render()}</div>
        </div>
      )}
      {sections
        .filter(
          ({ value }) =>
            !(
              settings &&
              (value === "agent:settings" || value === "agent:management")
            ) &&
            // Memory owns a one-shot read and a bounded session view, not a draft.
            (value === selected?.value ||
              (value !== "agent:memory" && visited.has(value))),
        )
        .map((section) => (
          <div
            role="tabpanel"
            id={panelId(section.value)}
            aria-labelledby={`${panelId(section.value)}-tab`}
            key={section.value}
            hidden={section.value !== selected?.value}
          >
            <div className="grid gap-6 pt-4">{section.render()}</div>
          </div>
        ))}
    </>
  );
}
