import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { AgentDetails } from "./AgentDetails";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { AgentMessageButton } from "./AgentMessageButton";
import { ProviderDialog } from "./ProviderDialog";
// Agents, teams, and marketplace, with creation and import from their menus.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import styles from "./AgentsPage.module.css";
import cardStyles from "./AgentCard.module.css";
import {
  AgentBrowse,
  SharedAgentPanel,
  type SharedAgentSelection,
} from "./AgentBrowse";
import { AgentCard, AgentPortrait, TeamCard } from "./AgentCard";
import { AgentCreateDialog, TypeIcon } from "./AgentCreateDialog";
import { NewAgentTile } from "./NewAgentTile";
import type { ChannelChoice } from "../../features/agents/attention";
import {
  AgentDelete,
  AgentRemoveHere,
  inSeveral,
  sameAgent,
} from "../../features/agents/AgentManage";
import { AttentionSummary } from "../../features/agents/AttentionPanel";
import { useAgents, useChannelChoices } from "../../features/agents/react";
import type {
  OldTeam,
  PortableAgent,
  PortSource,
} from "../../features/agents/native";
import type {
  Agent,
  Agents,
  FoundAgents,
  RegisteredAgentType,
  Team,
  TeamPort,
} from "../../features/agents/service";
import { useRelayConnection } from "../../features/relay/react";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { RelaySession } from "../../features/relay/session";
import {
  setDefaultAgent,
  useChosenAgent,
  useDefaultAgent,
} from "../../features/solo/default-agent";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import {
  CheckIcon,
  DotsThreeIcon,
  DownloadIcon,
  PlusIcon,
  RobotIcon,
  StarFilledIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { Panel } from "../../shared/design-system/ui/Panel";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuNote,
  MenuSeparator,
  MenuPopup,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Select } from "../../shared/design-system/ui/Select";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  canonicalPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { agentProviderRoute, agentProviderTarget } from "./routes";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The type's one-line summary of an agent; its title when it has none. */
function summaryOf(agent: Agent, type: RegisteredAgentType | undefined) {
  if (agent.place === "elsewhere") return "On another device";
  if (agent.unfinished) return "Setup unfinished";
  if (!type) return "Type unavailable";
  try {
    return type.summary?.(agent).trim() || type.title;
  } catch {
    return type.title;
  }
}

/** Pack avatars for the marketplace tile, apart from New agent's. */
const MARKETPLACE_ART = [
  "gloopies-7",
  "fuzzies-10",
  "pollies-9",
  "gloopies-14",
  "fuzzies-6",
  "pollies-21",
  "gloopies-11",
  "fuzzies-15",
];

type Tab = "yours" | "teams" | "marketplace";
const TABS = [
  { value: "yours", label: "Your agents", panelId: "agents-yours" },
  { value: "teams", label: "Your teams", panelId: "agents-teams" },
  { value: "marketplace", label: "Marketplace", panelId: "agents-marketplace" },
] as const;

export function AgentsPage({
  agents,
  relay,
  navigation,
  navigator,
}: {
  agents: Agents;
  relay: RelayData;
  navigation?: PageNavigation;
  navigator?: Navigation;
}) {
  const split = usePanelSplit(448, 320);
  const { snapshot, types } = useAgents(agents);
  const connection = useRelayConnection(relay);
  const channels = useChannelChoices(
    connection.status === "ready" ? connection.session.channels : undefined,
  );
  const [tab, setTab] = useState<Tab>("yours");
  const [sharedSelection, setSharedSelection] =
    useState<SharedAgentSelection>();
  const sharedTrigger = useRef<HTMLButtonElement | null>(null);
  const shared =
    connection.status === "ready" &&
    sharedSelection?.session === connection.session
      ? sharedSelection
      : undefined;
  // Commit first: a narrow layout hides the list, and its tile, while open.
  const closeShared = () => {
    flushSync(() => setSharedSelection(undefined));
    sharedTrigger.current?.focus();
  };
  const [selectedKey, setSelectedKey] = useState<string>();
  const [creating, setCreating] = useState(false);
  // Which import the dialog shows follows the menu it was opened from.
  const [flow, setFlow] = useState<"import" | "import-team">();
  // A team being edited by its id, or "new" for one being made.
  const [editingTeam, setEditingTeam] = useState<string>();
  const newAgentButton = useRef<HTMLButtonElement>(null);
  const newAgentLabel = useRef<HTMLSpanElement>(null);
  const [importing, setImporting] = useState(false);
  // What an owner with no agents yet can import, offered before anything else.
  const [importable, setImportable] = useState<readonly PortableAgent[]>([]);
  const firstAgent = snapshot.status === "ready" && !snapshot.agents.length;
  useEffect(() => {
    if (!firstAgent) return;
    let live = true;
    agents.portable().then(
      (found) => live && setImportable(found.agents),
      () => live && setImportable([]),
    );
    return () => {
      live = false;
    };
  }, [agents, firstAgent]);
  const [localProviderKey, setLocalProviderKey] = useState<string>();
  const routed = !!navigation && !!navigator;
  const providerKey = routed
    ? agentProviderRoute(
        navigation.target.kind === "page"
          ? navigation.target.route?.params
          : undefined,
      )
    : localProviderKey;
  const setProviderKey = (provider?: string, replace = false) => {
    if (!navigation || !navigator) {
      setLocalProviderKey(provider);
      return;
    }
    if (
      navigation.signal.aborted ||
      navigation.target.kind !== "page" ||
      navigation.target.pluginId !== "buzz.agents" ||
      navigation.target.pageId !== "agents" ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    const target = agentProviderTarget(navigation.target, provider);
    void (replace
      ? navigator.open(target, { replace: true })
      : navigator.open(target));
  };
  const typeOf = (agent: Agent) =>
    types.find((type) => type.key === agent.type);
  const find = (pubkey: string | undefined) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey);
  const selected = find(selectedKey);
  const browse = (pubkey?: string) => setSelectedKey(pubkey);
  const build = (pubkey: string) => browse(pubkey);
  // Importing gives an agent a key here, so a hosted type cannot take one.
  const runnable = types.filter((type) => !type.remote);
  // Teams are shared by every community; this one shows each with a member
  // here, or with none in any community.
  const members = new Set(snapshot.agents.map((agent) => agent.pubkey));
  const teams = snapshot.teams.filter(
    (team) =>
      team.members.some((pubkey) => members.has(pubkey)) ||
      !team.members.some((pubkey) => agents.memberships(pubkey).length),
  );
  // Only a team still saved, or one being made, keeps its editor open.
  const editing =
    editingTeam === "new" || teams.some((team) => team.id === editingTeam)
      ? editingTeam
      : undefined;
  // Leaving Teams drops the editor, whose unsaved draft goes with it.
  const changeTab = (next: Tab) => {
    if (next !== "teams") setEditingTeam(undefined);
    if (next !== "marketplace") setSharedSelection(undefined);
    setTab(next);
  };
  const returnTo = (next: Tab) => () => {
    setFlow(undefined);
    changeTab(next);
  };
  const returnToAgents = returnTo("yours");

  const toolbarAction =
    (tab === "teams" ? teams.length > 0 : snapshot.agents.length > 0) ||
    snapshot.status === "error" ||
    snapshot.status === "unavailable";
  const openImport = () => {
    browse();
    setFlow("import");
  };
  const openMarketplace = () => {
    browse();
    changeTab("marketplace");
  };
  // Shown only beside the tabs; with no agents yet, the tiles stand in for it.
  const newAgentMenu = (
    <MenuRoot>
      <MenuTrigger
        render={<NewAgentTile ref={newAgentButton} variant="button" />}
      />
      <MenuPopup anchor={newAgentButton} align="end">
        <MenuItem
          disabled={snapshot.status !== "ready" || !types.length}
          onClick={() => setCreating(true)}
        >
          <PlusIcon size={16} aria-hidden="true" /> Create a new agent
        </MenuItem>
        <MenuItem onClick={openImport}>
          <DownloadIcon size={16} aria-hidden="true" /> Import an agent
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
  // With no agents yet, each way to get one is its own tile; bringing the
  // owner's own agents leads when there are any.
  const elsewhere = firstAgent ? agents.joinable() : [];
  const crew = [...elsewhere, ...importable];
  const canImport = firstAgent && crew.length > 0;
  const starts = (
    <div className={cardStyles.starts}>
      {canImport && (
        <NewAgentTile
          fullWidth
          crew={crew}
          description={
            elsewhere.length
              ? "You have agents in your other communities."
              : "You have agents in a previous version of Buzz."
          }
          label="Import them now"
          onClick={openImport}
        />
      )}
      <NewAgentTile
        label="Create your first agent"
        secondary={canImport}
        disabled={snapshot.status !== "ready" || !types.length}
        onClick={() => setCreating(true)}
      />
      <NewAgentTile
        label="Explore the marketplace"
        art={MARKETPLACE_ART}
        secondary={canImport}
        onClick={openMarketplace}
      />
    </div>
  );
  // Teams have no marketplace, so New team offers only making and importing.
  const newTeamMenu = (
    <MenuRoot>
      <MenuTrigger
        render={
          toolbarAction ? (
            <NewAgentTile
              ref={newAgentButton}
              variant="button"
              label="New team"
            />
          ) : (
            <NewAgentTile
              ref={newAgentButton}
              labelRef={newAgentLabel}
              label="New team"
              fullWidth
            />
          )
        }
      />
      <MenuPopup
        anchor={toolbarAction ? newAgentButton : newAgentLabel}
        align={toolbarAction ? "end" : "center"}
      >
        <MenuItem
          disabled={snapshot.status !== "ready"}
          onClick={() => setEditingTeam("new")}
        >
          <PlusIcon size={16} aria-hidden="true" /> Create a new team
        </MenuItem>
        <MenuItem onClick={() => setFlow("import-team")}>
          <DownloadIcon size={16} aria-hidden="true" /> Import a team
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );

  const yours = (() => {
    if (snapshot.status === "unavailable")
      return (
        <EmptyState
          icon="✦"
          title="Agents runs in the desktop app"
          description="Agent keys stay in the desktop app's native custody."
        />
      );
    if (snapshot.status === "error")
      return (
        <EmptyState
          icon="!"
          title="Agents could not load"
          description={snapshot.error ?? "Try again."}
        />
      );
    const inventory = {
      service: agents,
      agents: snapshot.agents,
      selected: selected?.pubkey,
      typeOf,
      onSelect: browse,
      onBuild: build,
      newAgent: !toolbarAction && starts,
    };
    return connection.status === "ready" ? (
      <DefaultAgentInventory
        session={connection.session}
        scope={connection.scope ?? ""}
        {...inventory}
      />
    ) : (
      <Inventory {...inventory} />
    );
  })();

  const panel = selected ? (
    selected.unfinished || selected.place === "elsewhere" ? (
      <AgentPeek
        key={selected.pubkey}
        agents={agents}
        agent={selected}
        type={typeOf(selected)}
        channels={channels}
        onClose={() => browse()}
      />
    ) : (
      <AgentDetails
        messageAction={(variant) => (
          <AgentMessageButton
            variant={variant}
            pubkey={selected.pubkey}
            relay={relay}
            navigator={navigator}
            navigation={navigation}
          />
        )}
        key={selected.pubkey}
        agents={agents}
        agent={selected}
        type={typeOf(selected)}
        types={types}
        channels={channels}
        memories={
          connection.status === "ready"
            ? connection.session.agentMemories
            : undefined
        }
        onRemoved={() => browse()}
      />
    )
  ) : undefined;
  const body = (
    <div className={styles.inventory}>
      <div className={styles.content}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            variant="panel"
            label="Agent tabs"
            value={tab}
            onValueChange={changeTab}
            items={TABS}
          />
          {tab !== "marketplace" &&
            toolbarAction &&
            !(tab === "teams" && editing) &&
            (tab === "teams" ? newTeamMenu : newAgentMenu)}
        </div>
        <section
          id={`agents-${tab}`}
          role="tabpanel"
          aria-labelledby={`agents-${tab}-tab`}
        >
          {tab === "yours" ? (
            yours
          ) : tab === "marketplace" ? (
            <AgentBrowse
              relay={relay}
              selectedId={shared?.agent.id}
              onSelect={(selection, trigger) => {
                sharedTrigger.current = trigger;
                setSharedSelection(selection);
              }}
            />
          ) : (
            <Teams
              agents={agents}
              saved={snapshot.agents.filter((agent) => agent.place === "here")}
              teams={teams}
              editing={editing}
              onEdit={setEditingTeam}
              newTeam={!toolbarAction && newTeamMenu}
            />
          )}
        </section>
      </div>
    </div>
  );

  return (
    <div className="h-full min-h-0">
      <div
        ref={split.ref}
        style={split.style}
        className={styles.browse}
        data-side={
          (panel && tab === "yours") || (shared && tab === "marketplace")
            ? ""
            : undefined
        }
      >
        <div className={styles.main}>
          <Panel aria-label="Agents">
            <div className="flex h-full min-h-0 flex-col">
              <PanelHeader
                title={
                  <Tabs
                    variant="navigation"
                    label="Agents header"
                    value="agents"
                    onValueChange={() => {}}
                    showSelection={false}
                    items={[
                      {
                        value: "agents",
                        label: "Agents",
                        icon: <RobotIcon size="1rem" />,
                      },
                    ]}
                  />
                }
              />
              <div className="min-h-0 flex-1">{body}</div>
            </div>
          </Panel>
        </div>
        {shared && tab === "marketplace" && (
          <aside className={styles.side}>
            {split.handle}
            <Panel aria-label="Shared agent profile">
              <PanelWorkspace
                value={shared.agent.id}
                select={() => {}}
                items={[
                  {
                    id: shared.agent.id,
                    label: shared.agent.name,
                    close: closeShared,
                    content: (
                      <SharedAgentPanel
                        key={shared.agent.id}
                        selection={shared}
                        agents={agents}
                        types={runnable}
                        // The panel and its trigger go with it, so focus
                        // follows to the tab now shown.
                        onImported={() => {
                          flushSync(() => {
                            setSharedSelection(undefined);
                            returnToAgents();
                          });
                          document.getElementById("agents-yours-tab")?.focus();
                        }}
                      />
                    ),
                  },
                ]}
              />
            </Panel>
          </aside>
        )}
        {panel && selected && (
          <aside className={styles.side} hidden={tab !== "yours"}>
            {split.handle}
            <Panel aria-label="Agent profile">
              <PanelWorkspace
                focusOnMount={false}
                adoptSelection={selected.pubkey}
                value={selected.pubkey}
                select={() => {}}
                items={[
                  {
                    id: selected.pubkey,
                    label: selected.name,
                    content: panel,
                    close: () => browse(),
                  },
                ]}
              />
            </Panel>
          </aside>
        )}
      </div>
      {flow && (
        <Dialog
          open
          title={flow === "import" ? "Import an agent" : "Import a team"}
          size="wide"
          height="stable"
          preventClose={importing}
          finalFocus={newAgentButton}
          onOpenChange={(open) => {
            if (!open) setFlow(undefined);
          }}
        >
          <ImportAgents
            agents={agents}
            types={runnable}
            only={flow === "import" ? "agents" : "teams"}
            onImported={
              flow === "import" ? () => changeTab("yours") : returnTo("teams")
            }
            onPendingChange={setImporting}
          />
        </Dialog>
      )}
      {creating && (
        <AgentCreateDialog
          agents={agents}
          types={types}
          community={
            connection.status === "ready" ? connection.origin : undefined
          }
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            changeTab("yours");
            build(agent.pubkey);
          }}
        />
      )}
      {providerKey && (
        <ProviderDialog
          type={types.find((type) => type.key === providerKey)}
          finalFocus={newAgentButton}
          onClose={() => setProviderKey(undefined, true)}
        />
      )}
    </div>
  );
}

type InventoryProps = {
  service: Agents;
  agents: readonly Agent[];
  selected: string | undefined;
  typeOf(agent: Agent): RegisteredAgentType | undefined;
  onSelect(pubkey?: string): void;
  onBuild(pubkey: string): void;
  newAgent: ReactNode;
  /** The agent new Berd messages are tagged for, in this community. */
  defaultAgent?: string | undefined;
  /** False while another agent stands in for a missing chosen one. */
  defaultPinned?: boolean;
  onMakeDefault?: ((pubkey: string) => void) | undefined;
  defaultChoices?: ReadonlySet<string>;
};

/** The inventory with this community's default agent marked and settable. */
function DefaultAgentInventory({
  session,
  scope,
  ...props
}: InventoryProps & { session: RelaySession; scope: string }) {
  const current = useDefaultAgent(session, scope);
  const chosen = useChosenAgent(scope);
  const choices = useAgentChoices(session, true, true);
  const [error, setError] = useState("");
  return (
    <>
      <Inventory
        {...props}
        defaultAgent={current?.pubkey}
        defaultPinned={!!current && current.pubkey === chosen}
        defaultChoices={
          new Set(choices.selectable.map((agent) => agent.pubkey))
        }
        onMakeDefault={(pubkey) => {
          setError(
            setDefaultAgent(scope, pubkey)
              ? ""
              : "The main agent couldn't be saved on this device.",
          );
        }}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** Right-clicking an agent card opens its actions menu; the context-menu key
 * and Shift+F10 open it from the keyboard. */
function CardContextMenu({
  name,
  card,
  children,
}: {
  name: string;
  card: ReactElement;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement>();
  return (
    <ContextMenuRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setAnchor(undefined);
      }}
    >
      <ContextMenuTrigger
        render={card}
        // Right-clicks and long-presses in the card's open menus bubble
        // through their portals; only the card itself opens this menu.
        onContextMenu={(event) => {
          if (!event.currentTarget.contains(event.target as Node))
            event.preventBaseUIHandler();
        }}
        onTouchStart={(event) => {
          if (!event.currentTarget.contains(event.target as Node))
            event.preventBaseUIHandler();
        }}
        onKeyDown={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            event.stopPropagation();
            setAnchor(event.currentTarget);
            setOpen(true);
          }
        }}
      />
      <MenuPopup aria-label={`Actions for ${name}`} anchor={anchor}>
        {children}
      </MenuPopup>
    </ContextMenuRoot>
  );
}

/** Cards retain arrow navigation; their embedded controls have their own tab stops. The
 * New agent tile leads the grid but is its own stop. */
function Inventory({
  service,
  agents,
  selected,
  typeOf,
  onSelect,
  onBuild,
  newAgent,
  defaultAgent,
  defaultPinned,
  defaultChoices,
  onMakeDefault,
}: InventoryProps) {
  const grid = useRef<HTMLDivElement>(null);
  const index = agents.findIndex((agent) => agent.pubkey === selected);
  const columns = () =>
    grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length
      : 1;
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      !(event.target instanceof HTMLElement) ||
      event.target.getAttribute("role") !== "gridcell"
    )
      return;
    const last = agents.length - 1;
    const from = index < 0 ? -1 : index;
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns(),
    };
    let next: number | undefined;
    if (event.key in step) {
      const delta = step[event.key] ?? 0;
      next = from < 0 ? 0 : from + delta;
      if (next < 0 || next > last)
        next = Math.abs(delta) === 1 ? Math.min(Math.max(next, 0), last) : from;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter" && selected) {
      event.preventDefault();
      onBuild(selected);
      return;
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      onSelect();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    onSelect(agents[next]?.pubkey);
    grid.current
      ?.querySelectorAll<HTMLElement>('[role="gridcell"]')
      [next]?.focus();
  };
  return (
    <div ref={grid} className={cardStyles.grid}>
      {newAgent}
      {agents.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: This is a wrapping layout grid of interactive cards, not tabular data.
        <div
          role="grid"
          aria-label="Agents"
          className="contents"
          onKeyDown={onKeyDown}
        >
          {agents.map((agent, position) => {
            const type = typeOf(agent);
            const active = agent.pubkey === selected;
            const isMain = agent.pubkey === defaultAgent;
            return (
              // biome-ignore lint/a11y/useSemanticElements: Layout grid rows group cards without table layout.
              // biome-ignore lint/a11y/useFocusableInteractive: Roving focus belongs to the gridcell, not its row wrapper.
              <div role="row" className="contents" key={agent.pubkey}>
                <InventoryCard
                  tag={
                    isMain ? (
                      <Tooltip content="Main agent">
                        <span role="img" aria-label="Main agent">
                          <StarFilledIcon size={16} aria-hidden="true" />
                        </span>
                      </Tooltip>
                    ) : undefined
                  }
                  main={
                    onMakeDefault
                      ? {
                          isMain,
                          pinned: isMain && !!defaultPinned,
                          available: !!defaultChoices?.has(agent.pubkey),
                          onMake: () => onMakeDefault(agent.pubkey),
                        }
                      : undefined
                  }
                  service={service}
                  type={type}
                  onBuild={() => onBuild(agent.pubkey)}
                  onRemoved={() => onSelect()}
                  role="gridcell"
                  aria-label={isMain ? `${agent.name}, Main agent` : agent.name}
                  data-selected={active}
                  aria-selected={active}
                  tabIndex={active || (index < 0 && position === 0) ? 0 : -1}
                  data-unavailable={type ? undefined : ""}
                  onClick={(event) => {
                    if (
                      event.currentTarget.contains(event.target as Node) &&
                      !(event.target as Element).closest(
                        "[data-card-control], button, input",
                      )
                    )
                      onSelect(active ? undefined : agent.pubkey);
                  }}
                  onDoubleClick={(event) => {
                    if (
                      event.currentTarget.contains(event.target as Node) &&
                      !(event.target as Element).closest(
                        "[data-card-control], button, input",
                      )
                    )
                      onBuild(agent.pubkey);
                  }}
                  agent={agent}
                  community={agent.relay || undefined}
                  icon={<TypeIcon type={type} />}
                  detail={summaryOf(agent, type)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Card edits use the same type-owned field and service as creation/settings. */
function InventoryCard({
  service,
  type,
  onBuild,
  onRemoved,
  main,
  ...props
}: Omit<React.ComponentProps<typeof AgentCard>, "agent"> & {
  agent: Agent;
  service: Agents;
  type: RegisteredAgentType | undefined;
  onBuild(): void;
  onRemoved(): void;
  /** Whether it is the community's main agent and can be made it. */
  main?:
    | { isMain: boolean; pinned: boolean; available: boolean; onMake(): void }
    | undefined;
}) {
  const agent = props.agent;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editable = agent.place !== "elsewhere" && !agent.unfinished;
  const Model = editable ? type?.CreateModel : undefined;
  const save = async (config: unknown) => {
    setSaving(true);
    setError("");
    try {
      await service.save(agent.key, { config });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  };
  // The "..." button and right-click share one set of actions.
  const actions = (remove?: () => void, leave?: () => void) => (
    <>
      {main &&
        // A stand-in for a missing chosen agent can be made main for good.
        (main.pinned ? (
          <MenuNote>Main agent</MenuNote>
        ) : (
          <MenuItem disabled={!main.available} onClick={main.onMake}>
            Make main agent
          </MenuItem>
        ))}
      {main && <MenuSeparator />}
      {editable && <MenuItem onClick={onBuild}>Open settings</MenuItem>}
      <MenuItem
        onClick={() => {
          void navigator.clipboard
            .writeText(agent.pubkey)
            .catch((reason) => setError(message(reason)));
        }}
      >
        Copy public key
      </MenuItem>
      {leave && (
        <MenuItem tone="danger" onClick={leave}>
          Remove from this community
        </MenuItem>
      )}
      {remove && (
        <MenuItem tone="danger" onClick={remove}>
          Delete agent
        </MenuItem>
      )}
    </>
  );
  const card = (remove?: () => void, leave?: () => void) => (
    <CardContextMenu
      name={agent.name}
      card={
        <AgentCard
          {...props}
          icon={Model ? undefined : props.icon}
          detail={Model ? undefined : props.detail}
          menu={
            <MenuRoot>
              <MenuTrigger
                render={
                  <IconButton
                    aria-label={`Actions for ${agent.name}`}
                    variant="glass-ghost"
                    size="sm"
                    icon={<DotsThreeIcon size={16} />}
                  />
                }
              />
              <MenuPopup align="end">{actions(remove, leave)}</MenuPopup>
            </MenuRoot>
          }
        >
          {(Model || error) && (
            <div
              data-card-control=""
              className="flex min-w-0 max-w-full flex-col items-center gap-2"
            >
              {Model && (
                <Model
                  config={agent.config}
                  modelAppearance="glass-ghost"
                  disabled={saving}
                  onChange={(config) => void save(config)}
                />
              )}
              {error && (
                <span role="alert" className="text-body-sm text-danger">
                  {error}
                </span>
              )}
            </div>
          )}
        </AgentCard>
      }
    >
      {actions(remove, leave)}
    </CardContextMenu>
  );
  return agent.place === "elsewhere" ? (
    card()
  ) : (
    <AgentDelete
      agents={service}
      agent={agent}
      onRemoved={onRemoved}
      trigger={(remove) =>
        inSeveral(service, agent) ? (
          <AgentRemoveHere
            agents={service}
            agent={agent}
            onRemoved={onRemoved}
            trigger={(leave) => card(remove, leave)}
          />
        ) : (
          card(remove)
        )
      }
    />
  );
}

function SideHeader({ title, onClose }: { title: ReactNode; onClose(): void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">{title}</div>
      <IconButton
        aria-label="Close"
        size="sm"
        icon={<XIcon size={16} aria-hidden="true" />}
        onClick={onClose}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h4 className="m-0 text-caption text-secondary">{title}</h4>
      {children}
    </section>
  );
}

function AgentPeek({
  agents,
  agent,
  type,
  channels,
  onClose,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  onClose(): void;
}) {
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  const finish = async () => {
    setFinishing(true);
    setError("");
    try {
      await agents.finish(agent.pubkey);
    } catch (reason) {
      setError(message(reason));
    }
    setFinishing(false);
  };
  return (
    <div className={styles.sideBody}>
      <PeekIdentity
        agent={agent}
        detail={summaryOf(agent, type)}
        onClose={onClose}
      />
      {agent.place === "elsewhere" ? (
        <p className="m-0 text-body-sm text-secondary">
          Its key is on another of your devices, which runs it. Open Agents
          there to change or delete it.
        </p>
      ) : (
        <>
          <p className="m-0 text-body-sm text-secondary">
            Its provider made it, but its setup did not finish.
          </p>
          <Button
            variant="primary"
            loading={finishing}
            onClick={() => void finish()}
          >
            Finish setup
          </Button>
          {error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error}
            </p>
          )}
          <AgentDelete agents={agents} agent={agent} onRemoved={onClose} />
          {agent.place === "here" && (
            <Section title="Wakes on">
              <AttentionSummary agent={agent} channels={channels} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function PeekIdentity({
  agent,
  detail,
  onClose,
}: {
  agent: Agent;
  detail: string;
  onClose(): void;
}) {
  return (
    <div className={styles.peekIdentity}>
      <span className={styles.portraitLarge}>
        <AgentPortrait agent={agent} community={agent.relay || undefined} />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h3 className="m-0 truncate text-heading">{agent.name}</h3>
        <p className="m-0 text-body-sm text-secondary">{detail}</p>
      </div>
      <IconButton
        aria-label="Close"
        size="sm"
        icon={<XIcon size={16} aria-hidden="true" />}
        onClick={onClose}
      />
    </div>
  );
}

const SOURCES: Record<PortSource, string> = {
  harness: "Buzz 1.0 harness agent",
  installed: "Buzz 0.X",
  development: "Buzz 0.X dev",
};
const host = (relay: string) => relay.replace(/^wss:\/\//, "");
const sentence = (text: string) => text.replace(/\.?$/, ".");

/** What a team import left undone, or "" if nothing. */
function teamPortNote({
  team,
  imported,
  failed,
  elsewhere,
  foreign,
  teamError,
  notes = [],
}: TeamPort) {
  if (
    !failed.length &&
    !elsewhere.length &&
    !foreign.length &&
    !teamError &&
    !notes.length
  )
    return "";
  const came = imported.map((agent) => agent.name).join(", ");
  return [
    teamError
      ? `Couldn't save team ${teamError.name}. ${came ? `Imported ${came}; add them` : "Add its members"} in Teams.`
      : team && `Imported team ${team.name}${came ? ` with ${came}` : ""}.`,
    ...failed.map((member) =>
      sentence(`Couldn't import ${member.name}: ${member.error}`),
    ),
    elsewhere.length &&
      `Not added: ${elsewhere.join(", ")}, in your other communities. Use Add team to bring them here.`,
    foreign.length &&
      `Kept out: ${foreign.join(", ")}, which another account on this device has.`,
    ...notes,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Identities earlier agent systems saved on this machine, each imported
 * with its key, name and picture as an agent of the chosen type. */
function ImportAgents({
  agents,
  types,
  only,
  onImported,
  onPendingChange,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  /** The section its entry point imports. */
  only: "agents" | "teams";
  onImported(): void;
  onPendingChange(pending: boolean): void;
}) {
  const [found, setFound] = useState<FoundAgents>();
  const [type, setType] = useState(types[0]?.key ?? "");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  // Each agent the owner chose, in the order chosen: imports run one at a
  // time and the dialog stays open, so several can be picked in a row.
  const [ports, setPorts] = useState<ReadonlyMap<string, "queued" | "done">>(
    new Map(),
  );
  // What did not come over, or why an import failed, by agent; choosing the
  // agent again replaces it.
  const [said, setSaid] = useState<ReadonlyMap<string, string>>(new Map());
  const chosenPorts = useRef(new Set<string>());
  const portLine = useRef(Promise.resolve());
  // An import still waiting its turn when the dialog goes away is dropped:
  // it would otherwise land in whatever community is selected by then.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const queued = [...ports.values()].includes("queued");
  useEffect(() => onPendingChange(queued), [queued, onPendingChange]);
  useEffect(() => {
    let live = true;
    agents.portable().then(
      (next) => live && setFound(next),
      (reason) => live && setError(message(reason)),
    );
    return () => {
      live = false;
    };
  }, [agents]);
  const chosen = types.find((item) => item.key === type) ?? types[0];
  const labels = publicKeyLabels(found?.agents.map((a) => a.pubkey) ?? []);
  const named = new Map<string, number>();
  for (const agent of found?.agents ?? [])
    named.set(agent.name, (named.get(agent.name) ?? 0) + 1);
  const setPort = (pubkey: string, state?: "queued" | "done") =>
    setPorts((last) => {
      const next = new Map(last);
      if (state) next.set(pubkey, state);
      else next.delete(pubkey);
      return next;
    });
  const say = (pubkey: string, text?: string) =>
    setSaid((last) => {
      const next = new Map(last);
      if (text) next.set(pubkey, text);
      else next.delete(pubkey);
      return next;
    });
  /** Runs `bring` for the agent after the ones chosen before it. */
  const queue = (
    pubkey: string,
    failed: string,
    bring: () => Promise<Readonly<{ notes: readonly string[] }>>,
  ) => {
    if (chosenPorts.current.has(pubkey)) return;
    chosenPorts.current.add(pubkey);
    setPort(pubkey, "queued");
    say(pubkey);
    portLine.current = portLine.current.then(async () => {
      if (!open.current) return;
      try {
        const { notes } = await bring();
        setPort(pubkey, "done");
        if (notes.length) say(pubkey, notes.join(" "));
        onImported();
      } catch (reason) {
        chosenPorts.current.delete(pubkey);
        setPort(pubkey);
        say(pubkey, `${failed} ${sentence(message(reason))}`);
      }
    });
  };
  const port = (agent: PortableAgent) => {
    if (!chosen) return;
    const type = chosen.key;
    queue(agent.pubkey, `${agent.name} wasn't imported.`, () =>
      agents.port({ source: agent.source, pubkey: agent.pubkey, type }),
    );
  };
  const join = (agent: Agent) =>
    queue(agent.pubkey, `${agent.name} wasn't added.`, () =>
      agents.join(agent.key),
    );
  /** Adds each of the team's members from the owner's other communities, so
   * the team, which every community shares, has them here too. */
  const joinTeam = async (team: Team, members: readonly Agent[]) => {
    if (pending) return;
    setPending(team.id);
    onPendingChange(true);
    setError("");
    const notes: string[] = [];
    for (const member of members)
      try {
        notes.push(...(await agents.join(member.key)).notes);
      } catch (reason) {
        notes.push(`${member.name} wasn't added. ${sentence(message(reason))}`);
      }
    setPending(undefined);
    onPendingChange(false);
    // Leaving would hide the one place that names what still needs a hand.
    if (notes.length) setError(notes.join(" "));
    else onImported();
  };
  const portTeam = async (team: OldTeam) => {
    if (!chosen || pending) return;
    setPending(team.id);
    onPendingChange(true);
    setError("");
    try {
      const result = await agents.portTeam({ id: team.id, type: chosen.key });
      const came = new Set(result.imported.map((agent) => agent.pubkey));
      setFound(
        (last) =>
          last && {
            ...last,
            agents: last.agents.filter((item) => !came.has(item.pubkey)),
            here: [...last.here, ...came],
          },
      );
      // Leaving would hide the one place that names what still needs a hand.
      const note = teamPortNote(result);
      if (note) setError(note);
      else onImported();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(undefined);
      onPendingChange(false);
    }
  };
  const yours = new Set(found?.here);
  // The owner's agents in their other communities, as offered since the
  // dialog opened, so one added here stays listed as added, and those its
  // community lists only once it connects still come.
  const { snapshot } = useAgents(agents);
  const [offered, setOffered] = useState(() => agents.joinable());
  // biome-ignore lint/correctness/useExhaustiveDependencies: What it can join changes with the snapshot.
  useEffect(() => {
    setOffered((shown) => {
      const more = agents
        .joinable()
        .filter((agent) => !shown.some((item) => item.key === agent.key));
      return more.length ? [...shown, ...more] : shown;
    });
  }, [agents, snapshot]);
  const joinable = new Map(
    agents.joinable().map((agent) => [agent.pubkey, agent]),
  );
  const elsewhere = only === "agents" ? offered : [];
  const teamsElsewhere =
    only === "teams"
      ? snapshot.teams.flatMap((team) => {
          const members = team.members.flatMap((pubkey) => {
            const agent = joinable.get(pubkey);
            return agent ? [agent] : [];
          });
          return members.length ? [{ team, members }] : [];
        })
      : [];
  const others = elsewhere.length + teamsElsewhere.length;
  // Old Buzz's guidance and type stay out of a list of other communities'.
  const old = !!found && (found[only].length > 0 || !others);
  if (!types.length)
    return (
      <p className="m-0 text-body-sm text-secondary">
        Enable an agent type plugin to import agents.
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      {(error || said.size > 0) && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {[error, ...said.values()].filter(Boolean).join(" ")}
        </p>
      )}
      {elsewhere.length > 0 && (
        <section
          aria-label="Agents in your other communities"
          className="flex flex-col gap-3"
        >
          <InlineHeader title="From your other communities" />
          <p className="m-0 text-body-sm text-secondary">
            Adds the same agent here. {sameAgent()}
          </p>
          <div className={cardStyles.grid}>
            {elsewhere.map((agent) => (
              <AgentCard
                key={agent.pubkey}
                agent={agent}
                community={agent.relay}
                icon={
                  <TypeIcon
                    type={types.find((item) => item.key === agent.type)}
                  />
                }
                detail={host(agent.relay)}
              >
                {ports.get(agent.pubkey) === "done" ? (
                  <Button
                    size="compact"
                    variant="outline"
                    aria-label={`${agent.name} added`}
                    disabled
                    // Keeps the owner's place for the next one.
                    focusableWhenDisabled
                  >
                    <CheckIcon size={16} aria-hidden="true" /> Added
                  </Button>
                ) : (
                  <Button
                    size="compact"
                    variant="outline"
                    aria-label={`Add ${agent.name} from ${host(agent.relay)}`}
                    loading={ports.get(agent.pubkey) === "queued"}
                    onClick={() => join(agent)}
                  >
                    Add
                  </Button>
                )}
              </AgentCard>
            ))}
          </div>
        </section>
      )}
      {teamsElsewhere.length > 0 && (
        <section
          aria-label="Teams in your other communities"
          className="flex flex-col gap-3"
        >
          <InlineHeader title="From your other communities" />
          <p className="m-0 text-body-sm text-secondary">
            Adds the team's members from your other communities here, so the
            team has them here too.
          </p>
          <ul className={styles.portList}>
            {teamsElsewhere.map(({ team, members }) => (
              <li key={team.id} className={styles.portRow}>
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body">{team.name}</span>
                  <span className="truncate text-caption text-secondary">
                    {members.map((member) => member.name).join(", ")}
                  </span>
                </span>
                <Button
                  size="compact"
                  variant="outline"
                  aria-label={`Add team ${team.name}`}
                  loading={pending === team.id}
                  disabled={!!pending && pending !== team.id}
                  onClick={() => void joinTeam(team, members)}
                >
                  Add team
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {old && others > 0 && (
        <InlineHeader title="From earlier versions of Buzz" />
      )}
      {old && (
        <p className="m-0 text-body-sm text-secondary">
          {chosen?.adopt
            ? "Keeps each agent's key, name, picture and instructions in this community. Its provider, model and other settings stay behind; choose them after importing."
            : "Keeps each agent's key, name and picture in this community. Its instructions, provider, model and other settings stay behind; choose them after importing."}{" "}
          An archived agent is unarchived here. Stop it where it runs now first,
          or both will answer.
        </p>
      )}
      {old && types.length > 1 && (
        <div className="flex">
          <Select
            label="Import as"
            value={chosen?.key ?? ""}
            disabled={!!pending || queued}
            groups={[
              {
                label: "Agent types",
                options: types.map((item) => ({
                  value: item.key,
                  label: item.title,
                })),
              },
            ]}
            onValueChange={setType}
          />
        </div>
      )}
      {found?.warnings.map((warning) => (
        <p key={warning} className="m-0 text-body-sm text-secondary">
          {warning}
        </p>
      ))}
      {!found ? (
        !error && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            Looking for agents…
          </p>
        )
      ) : found[only].length ? (
        <>
          {only === "teams" && (
            <section aria-label="Teams to import">
              <InlineHeader title="Teams" />
              <ul className={styles.portList}>
                {found.teams.map((team) => {
                  const here = team.members.filter((member) =>
                    yours.has(member.pubkey),
                  ).length;
                  return (
                    <li key={team.id} className={styles.portRow}>
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate text-body">{team.name}</span>
                        <span className="truncate text-caption text-secondary">
                          {[
                            `${team.members.length} ${team.members.length === 1 ? "member" : "members"}`,
                            here > 0 && `${here} already here`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <Button
                        size="compact"
                        variant="outline"
                        aria-label={`Import team ${team.name}`}
                        loading={pending === team.id}
                        disabled={!chosen || (!!pending && pending !== team.id)}
                        onClick={() => void portTeam(team)}
                      >
                        Import team
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {only === "agents" && (
            <section aria-label="Agents to import" className={cardStyles.grid}>
              {found.agents.map((agent) => (
                <AgentCard
                  key={agent.pubkey}
                  agent={agent}
                  community={agent.relay || undefined}
                  detail={
                    <Tooltip
                      content={[
                        canonicalPublicKey(agent.pubkey),
                        agent.relay && host(agent.relay),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      delay={300}
                    >
                      <span
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to its key and community in the tooltip.
                        tabIndex={0}
                      >
                        {[
                          SOURCES[agent.source],
                          // Its key tells it apart only from one of the same name.
                          named.get(agent.name) !== 1 &&
                            labels.get(agent.pubkey),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </Tooltip>
                  }
                >
                  {ports.get(agent.pubkey) === "done" ? (
                    <Button
                      size="compact"
                      variant="outline"
                      aria-label={`${agent.name} imported`}
                      disabled
                      // Keeps the owner's place for the next import.
                      focusableWhenDisabled
                    >
                      <CheckIcon size={16} aria-hidden="true" /> Imported
                    </Button>
                  ) : (
                    <Button
                      size="compact"
                      variant="outline"
                      aria-label={`Import ${agent.name}`}
                      loading={ports.get(agent.pubkey) === "queued"}
                      disabled={!chosen}
                      onClick={() => port(agent)}
                    >
                      Import
                    </Button>
                  )}
                </AgentCard>
              ))}
            </section>
          )}
        </>
      ) : (
        old && (
          <p className="m-0 text-body-sm text-secondary">
            {only === "teams"
              ? "No old teams found to import."
              : "No other agents found to import."}
          </p>
        )
      )}
    </div>
  );
}

/** The owner's teams: each a name, instructions and members, given to every
 * member's prompt with a roster. Agents record nothing about their teams. */
function Teams({
  agents,
  saved,
  teams,
  editing,
  onEdit,
  newTeam,
}: {
  agents: Agents;
  saved: readonly Agent[];
  teams: readonly Team[];
  /** A team's id while it is edited, or "new" for one being made. */
  editing: string | undefined;
  onEdit(id: string | undefined): void;
  newTeam: ReactNode;
}) {
  const team = teams.find((item) => item.id === editing);
  if (editing === "new" || team)
    return (
      <TeamEditor
        key={editing}
        agents={agents}
        saved={saved}
        {...(team ? { team } : {})}
        onDone={() => onEdit(undefined)}
      />
    );
  const byKey = new Map(saved.map((agent) => [agent.pubkey, agent]));
  return (
    <div className="grid gap-4">
      <div className={cardStyles.grid}>
        {newTeam}
        {teams.length > 0 && (
          <ul className="contents" aria-label="Teams">
            {teams.map((item) => (
              <li key={item.id} className="contents">
                <TeamCard
                  name={item.name}
                  aria-label={item.name}
                  members={item.members.flatMap((pubkey) => {
                    const member = byKey.get(pubkey);
                    return member
                      ? [{ ...member, community: member.relay || undefined }]
                      : [];
                  })}
                  onClick={() => onEdit(item.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TeamEditor({
  agents,
  saved,
  team,
  onDone,
}: {
  agents: Agents;
  saved: readonly Agent[];
  team?: Team;
  onDone(): void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [instructions, setInstructions] = useState(team?.instructions ?? "");
  const [members, setMembers] = useState<readonly string[]>(
    team?.members ?? [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // Members not in this community, which it doesn't list but keeps.
  const away = members.filter(
    (pubkey) =>
      !saved.some((agent) => agent.pubkey === pubkey) &&
      agents.memberships(pubkey).length > 0,
  ).length;
  const act = async (work: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await work();
      onDone();
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  const save = () =>
    act(() =>
      agents.saveTeam({
        ...(team ? { id: team.id } : {}),
        name: name.trim(),
        instructions,
        members,
      }),
    );
  return (
    <form
      className={styles.sideBody}
      aria-label={team ? `Edit ${team.name}` : "New team"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onDone();
      }}
    >
      <SideHeader
        title={
          <h3 className="m-0 text-heading">
            {team ? "Edit team" : "New team"}
          </h3>
        }
        onClose={onDone}
      />
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Instructions"
        description="Every member follows these after its own instructions."
      >
        <Textarea
          rows={5}
          value={instructions}
          disabled={pending}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      <Section title="Members">
        {saved.length ? (
          <div className="grid gap-2">
            {saved.map((agent) => (
              <Checkbox
                key={agent.pubkey}
                label={agent.name}
                checked={members.includes(agent.pubkey)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setMembers((last) =>
                    checked
                      ? [...last, agent.pubkey]
                      : last.filter((pubkey) => pubkey !== agent.pubkey),
                  )
                }
              />
            ))}
          </div>
        ) : (
          <p className="m-0 text-body-sm text-secondary">No agents yet.</p>
        )}
        {away > 0 && (
          <p className="m-0 text-body-sm text-secondary">
            {`+${away} in your other communities, who stay on the team.`}
          </p>
        )}
      </Section>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={!name.trim()}
        >
          {team ? "Save" : "Create team"}
        </Button>
        {team && (
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void act(() => agents.removeTeam(team.id))}
          >
            Delete team
          </Button>
        )}
      </div>
    </form>
  );
}
