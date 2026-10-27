// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's tabs, local-only Attention, and Memory.
// Memory is relay-backed for both local and hosted agents. Agents classified
// as `elsewhere` expose no sections in these views.
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ChannelChoice } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import { MemoryPanel, type AgentMemories } from "./MemoryPanel";
import type { CommunityReader } from "../communities/service";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  Agents,
  RegisteredAgentType,
} from "./service";
import { AgentSaveButton, useAgentSaveState } from "./AgentSaveButton";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>`, `agent:settings`, `agent:activity`, `agent:attention`
   * or `agent:memory`; never collides with a host tab. */
  value: `agent:${string}`;
  label: string;
  render(): ReactNode;
}>;

export function agentSections({
  agents,
  agent,
  type,
  channels,
  conversation,
  settingsHost,
  memories,
  communities,
  settingsSection,
  settingsContent,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  conversation?: AgentConversation | undefined;
  settingsHost?: AgentSettingsHost;
  settingsSection?: "identity" | "runtime";
  settingsContent?: ReactNode;
  /** Memory reads through the owner's session; absent while it connects. */
  memories: AgentMemories | undefined;
  communities?: CommunityReader | undefined;
}): readonly AgentSection[] {
  if (agent.place === "elsewhere") return [];
  const typeTabs = type?.tabs ?? [];
  const settingsTab = settingsHost
    ? typeTabs.find((tab) => tab.role === "settings")
    : undefined;
  const orderedTabs = settingsTab
    ? [settingsTab, ...typeTabs.filter((tab) => tab !== settingsTab)]
    : typeTabs;
  const tabs = orderedTabs.map(({ id, title, role, component: Component }) => ({
    value: (role ? `agent:${role}` : `agent:type:${id}`) as `agent:${string}`,
    label: title,
    render: () => (
      <Component
        agent={agent}
        {...(role === "settings" && settingsSection ? { settingsSection } : {})}
        {...(role === "settings" && settingsContent ? { settingsContent } : {})}
        {...(conversation && { conversation })}
        save={(config) =>
          settingsHost?.pendingSave
            ? settingsHost.pendingSave(config)
            : agents.save(agent.key, { config })
        }
        {...(role === "settings" && settingsHost ? { settingsHost } : {})}
      />
    ),
  }));
  if (settingsHost && !settingsTab)
    tabs.unshift({
      value: "agent:settings",
      label: "Settings",
      render: () => <HostSettings host={settingsHost} />,
    });
  if (agent.place === "here")
    tabs.push({
      value: "agent:attention",
      label: "Attention",
      render: () => (
        <AttentionSection agents={agents} agent={agent} channels={channels} />
      ),
    });
  return [
    ...tabs,
    {
      value: "agent:memory",
      label: "Memory",
      render: () => (
        <MemoryPanel
          agent={agent}
          memories={memories}
          communities={communities}
        />
      ),
    },
  ];
}

function HostSettings({ host }: { host: AgentSettingsHost }) {
  const form = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!host.pendingSave) return;
    setSaving(true);
    setError("");
    try {
      await host.pendingSave();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      id={form}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {host.typeControl?.(false)}
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
      <AgentSaveButton
        form={form}
        saving={saving}
        disabled={!host.pendingSave}
      />
    </form>
  );
}

/** Follows classifier availability itself: a host that rerenders only when
 * this agent changes would otherwise show a stale classifier warning. */
function AttentionSection({
  agents,
  agent,
  channels,
}: {
  agents: Pick<Agents, "subscribe" | "classifier" | "save">;
  agent: Agent;
  channels: readonly ChannelChoice[];
}) {
  // Every Attention write must settle before its section can unmount.
  const [pending, setPending] = useState(0);
  useAgentSaveState(false, pending > 0);
  const classifier = useSyncExternalStore(
    agents.subscribe,
    () => agents.classifier(),
    () => agents.classifier(),
  );
  return (
    <AttentionPanel
      agent={agent}
      save={async (change) => {
        setPending((count) => count + 1);
        try {
          await agents.save(agent.key, change);
        } finally {
          setPending((count) => count - 1);
        }
      }}
      channels={channels}
      classifier={classifier}
    />
  );
}
