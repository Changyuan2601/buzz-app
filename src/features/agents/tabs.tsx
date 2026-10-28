// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's tabs, settings, and Memory.
// Memory is relay-backed for both local and hosted agents. Agents classified
// as `elsewhere` expose no sections in these views.
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { AgentConfigHistory } from "./AgentConfigHistory";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>`, `agent:settings`, `agent:activity`
   * or `agent:memory`; never collides with a host tab. */
  value: `agent:${string}`;
  label: string;
  render(): ReactNode;
}>;

export function agentSections({
  agents,
  agent,
  type,
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
  conversation?: AgentConversation | undefined;
  settingsHost?: AgentSettingsHost;
  settingsSection?: "identity" | "runtime";
  settingsContent?: ReactNode;
  /** Memory reads through the owner's session; absent while it connects. */
  memories: AgentMemories | undefined;
  communities?: CommunityReader | undefined;
}): readonly AgentSection[] {
  if (agent.place === "elsewhere") return [];
  const attention =
    settingsContent === undefined && agent.place === "here" ? (
      <AttentionSection agents={agents} agent={agent} />
    ) : null;
  const content = attention || settingsContent;
  const typeTabs = type?.tabs ?? [];
  const settingsTab = typeTabs.find((tab) => tab.role === "settings");
  const orderedTabs =
    settingsHost && settingsTab
      ? [settingsTab, ...typeTabs.filter((tab) => tab !== settingsTab)]
      : typeTabs;
  const tabs = orderedTabs.map(({ id, title, role, component: Component }) => ({
    value: (role ? `agent:${role}` : `agent:type:${id}`) as `agent:${string}`,
    label: title,
    render: () => (
      <EditorBase agents={agents} agent={agent}>
        {(save) => (
          <Component
            agent={agent}
            {...(role === "settings" && settingsSection
              ? { settingsSection }
              : {})}
            {...(role === "settings" && content
              ? { settingsContent: content }
              : {})}
            {...(conversation && { conversation })}
            save={(config) =>
              settingsHost?.pendingSave
                ? settingsHost.pendingSave(config)
                : save(config)
            }
            {...(role === "settings" && settingsHost ? { settingsHost } : {})}
          />
        )}
      </EditorBase>
    ),
  }));
  if (!settingsTab && (settingsHost || attention))
    tabs.unshift({
      value: "agent:settings",
      label: "Settings",
      render: () => (
        <>
          {settingsHost && <HostSettings host={settingsHost} />}
          {attention}
        </>
      ),
    });
  if (agent.place === "here" && agents.configHistory(agent.pubkey))
    tabs.push({
      value: "agent:history",
      label: "History",
      render: () => <ConfigHistoryTab agents={agents} pubkey={agent.pubkey} />,
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

/** The device-local Attention control, with pending writes tracked by Settings. */
export function AttentionSection({
  agents,
  agent,
}: {
  agents: Pick<Agents, "save">;
  agent: Agent;
}) {
  const [pending, setPending] = useState(0);
  useAgentSaveState(false, pending > 0);
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
    />
  );
}

/** Each synced side's History, current as the agent's config changes. */
function ConfigHistoryTab({
  agents,
  pubkey,
}: {
  agents: Pick<Agents, "configHistory" | "snapshot" | "subscribe">;
  pubkey: string;
}) {
  // Render reads a mutable store that the subscription above only signals.
  // The React Compiler would cache that read, so it must skip this.
  "use no memo";
  useSyncExternalStore(agents.subscribe, agents.snapshot);
  const history = agents.configHistory(pubkey);
  if (!history) return <p>This agent's config doesn't sync here.</p>;
  return history.sides.map(({ side, expected, head, version }) => (
    <AgentConfigHistory
      key={side}
      title={side === "settings" ? "Settings history" : "Instructions history"}
      expected={expected}
      head={head}
      version={version}
      read={history.read}
      {...(side === "settings" && history.settings
        ? { settings: history.settings }
        : {})}
      onRevert={(template) => history.revise(side, template)}
    />
  ));
}

/** Saves a type tab's config as a revision of the synced heads it opened
 * with, so an edit made over a stale view conflicts instead of overwriting.
 * Each save moves the base to what it saved. */
function EditorBase({
  agents,
  agent,
  children,
}: {
  agents: Pick<Agents, "save" | "snapshot">;
  agent: Agent;
  children(save: (config: unknown) => Promise<void>): ReactNode;
}) {
  const [base, setBase] = useState(agent.configBase);
  const editor = children(async (config) => {
    await agents.save(agent.key, { config, ...(base && { base }) });
    setBase(
      agents.snapshot().agents.find((a) => a.key === agent.key)?.configBase,
    );
  });
  return agent.configProblem ? (
    <>
      <p role="alert" className="buzz-field-error">
        {agent.configProblem}
      </p>
      {editor}
    </>
  ) : (
    editor
  );
}
