// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's tabs, local-only Attention, and Memory.
// Memory is relay-backed for both local and hosted agents. Agents classified
// as `elsewhere` expose no sections in these views.
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ChannelChoice } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import { MemoryPanel, type AgentMemories } from "./MemoryPanel";
import type {
  Agent,
  AgentConversation,
  AgentRestart,
  AgentSettingsHost,
  Agents,
  RegisteredAgentType,
} from "./service";
import { AgentSaveButton } from "./AgentSaveButton";
import { AgentConfigHistory } from "./AgentConfigHistory";
import { Button } from "../../shared/design-system/ui/Button";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>`, `agent:settings`, `agent:activity`, `agent:history`, `agent:attention`
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
      <EditorBase agents={agents} agent={agent}>
        {(save) => (
          <>
            {role === "settings" && type?.restart && (
              <RestartNotice
                agents={agents}
                pubkey={agent.pubkey}
                restart={type.restart}
              />
            )}
            <Component
              agent={agent}
              {...(role === "settings" && settingsSection
                ? { settingsSection }
                : {})}
              {...(role === "settings" && settingsContent
                ? { settingsContent }
                : {})}
              {...(conversation && { conversation })}
              save={(config) =>
                settingsHost?.pendingSave
                  ? settingsHost.pendingSave(config)
                  : save(config)
              }
              {...(role === "settings" && settingsHost ? { settingsHost } : {})}
            />
          </>
        )}
      </EditorBase>
    ),
  }));
  if (settingsHost && !settingsTab)
    tabs.unshift({
      value: "agent:settings",
      label: "Settings",
      render: () => <HostSettings host={settingsHost} />,
    });
  if (agent.place === "here")
    tabs.push(
      ...(agents.configHistory(agent.pubkey)
        ? [
            {
              value: "agent:history" as const,
              label: "History",
              render: () => (
                <ConfigHistoryTab agents={agents} pubkey={agent.pubkey} />
              ),
            },
          ]
        : []),
      {
        value: "agent:attention",
        label: "Attention",
        render: () => (
          <AttentionSection agents={agents} agent={agent} channels={channels} />
        ),
      },
    );
  return [
    ...tabs,
    {
      value: "agent:memory",
      label: "Memory",
      render: () => <MemoryPanel agent={agent} memories={memories} />,
    },
  ];
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
  return children(async (config) => {
    await agents.save(agent.pubkey, { config, ...(base && { base }) });
    setBase(
      agents.snapshot().agents.find((a) => a.pubkey === agent.pubkey)
        ?.configBase,
    );
  });
}

/** Shown while a running conversation is on older config than the agent's
 * current copy, as after an edit on another device: Restart to apply moves
 * them onto it. */
function RestartNotice({
  agents,
  pubkey,
  restart,
}: {
  agents: Pick<Agents, "find" | "subscribe">;
  pubkey: string;
  restart: AgentRestart;
}) {
  const outdated = useSyncExternalStore(
    (listener) => {
      const offAgents = agents.subscribe(listener);
      const offSessions = restart.subscribe(listener);
      return () => {
        offAgents();
        offSessions();
      };
    },
    () => {
      const agent = agents.find(pubkey);
      return !!agent && restart.outdated(pubkey, agent.config);
    },
  );
  if (!outdated) return null;
  return (
    <div role="status" className="flex items-center justify-between gap-3">
      <p>Running conversations use an older version of this config.</p>
      <Button onClick={() => restart.apply(pubkey)}>Restart to apply</Button>
    </div>
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
  const classifier = useSyncExternalStore(
    agents.subscribe,
    () => agents.classifier(),
    () => agents.classifier(),
  );
  return (
    <AttentionPanel
      agent={agent}
      save={(change) => agents.save(agent.pubkey, change)}
      channels={channels}
      classifier={classifier}
    />
  );
}
