// The Agents2 page. Three frames, one at a time:
// - Inventory: every agent as a tile. Selecting one (click, or arrow keys) opens
//   its peek beside the grid without leaving it; Enter or a double-click builds.
// - Peek: identity, the type's own read-only glance, and what wakes it.
// - Build: the identity rail on the left, the type's tabs and the app's
//   Attention tab on the right.
// New agents are made in the peek slot, so making one never covers the grid,
// and so are agents brought over from an earlier agent system.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import styles from "./Agents2Page.module.css";
import { AgentTabs } from "./AgentTabs";
import type { ChannelChoice } from "../../features/agents2/attention";
import { AgentDelete } from "../../features/agents2/AgentManage";
import { AttentionSummary } from "../../features/agents2/AttentionPanel";
import { AvatarEditor } from "../../features/profiles/AvatarEditor";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { useAgents2, useChannelChoices } from "../../features/agents2/react";
import type {
  PortableAgent,
  PortableAgents,
  PortSource,
} from "../../features/agents2/native";
import type {
  Agent,
  Agents2,
  RegisteredAgentType,
} from "../../features/agents2/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import {
  ArrowLeftIcon,
  CopyIcon,
  PlusIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Frame =
  | {
      view: "browse";
      selected?: string;
      side?: "creating" | "porting";
    }
  | { view: "build"; pubkey: string };

/** The type's one-line summary of an agent; its title when it has none. */
function summaryOf(agent: Agent, type: RegisteredAgentType | undefined) {
  if (!type) return "Type unavailable";
  try {
    return type.summary?.(agent).trim() || type.title;
  } catch {
    return type.title;
  }
}

export function Agents2Page({
  agents2,
  relay,
}: {
  agents2: Agents2;
  relay: RelayData;
}) {
  const { snapshot, types } = useAgents2(agents2);
  const connection = useRelayConnection(relay);
  const channels = useChannelChoices(
    connection.status === "ready" ? connection.session.channels : undefined,
  );
  const [frame, setFrame] = useState<Frame>({ view: "browse" });
  const typeOf = (agent: Agent) =>
    types.find((type) => type.key === agent.type);
  const find = (pubkey: string | undefined) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey);
  const building = frame.view === "build" ? find(frame.pubkey) : undefined;
  const selected = frame.view === "browse" ? find(frame.selected) : undefined;
  const side = frame.view === "browse" ? frame.side : undefined;
  const creating = side === "creating";
  const browse = (selected?: string) =>
    setFrame(selected ? { view: "browse", selected } : { view: "browse" });
  const build = (pubkey: string) => setFrame({ view: "build", pubkey });
  const newAgent = () => setFrame({ view: "browse", side: "creating" });
  const bringOver = () => setFrame({ view: "browse", side: "porting" });

  const body = (() => {
    if (snapshot.status === "unavailable")
      return (
        <EmptyState
          icon="✦"
          title="Agents2 runs in the desktop app"
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
    if (building)
      return (
        <AgentBuild
          key={building.pubkey}
          agents2={agents2}
          agent={building}
          type={typeOf(building)}
          channels={channels}
          onRemoved={() => browse()}
        />
      );
    const panel = creating ? (
      <NewAgent
        agents2={agents2}
        types={types}
        onClose={() => browse()}
        onCreated={(agent) => build(agent.pubkey)}
      />
    ) : side === "porting" ? (
      <BringOver agents2={agents2} types={types} onClose={() => browse()} />
    ) : selected ? (
      <AgentPeek
        key={selected.pubkey}
        agent={selected}
        type={typeOf(selected)}
        channels={channels}
        onBuild={() => build(selected.pubkey)}
        onClose={() => browse()}
      />
    ) : undefined;
    return (
      <div className={styles.browse} data-side={panel ? "" : undefined}>
        <div className={styles.inventory}>
          {snapshot.agents.length ? (
            <Inventory
              agents={snapshot.agents}
              selected={selected?.pubkey}
              typeOf={typeOf}
              onSelect={browse}
              onBuild={build}
            />
          ) : snapshot.status === "ready" && !side ? (
            <EmptyState
              icon="✦"
              title="No agents yet"
              description={
                types.length
                  ? "An agent has its own key and wakes when it is mentioned or something it watches happens."
                  : "Enable an agent type plugin to make one."
              }
              {...(types.length
                ? {
                    action: (
                      <Button variant="primary" onClick={newAgent}>
                        New agent
                      </Button>
                    ),
                  }
                : {})}
            />
          ) : null}
        </div>
        {panel && <aside className={styles.side}>{panel}</aside>}
      </div>
    );
  })();

  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents2">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            {...(building
              ? {
                  navigation: (
                    <IconButton
                      aria-label="All agents"
                      size="sm"
                      icon={<ArrowLeftIcon size={16} aria-hidden="true" />}
                      onClick={() => browse(building.pubkey)}
                    />
                  ),
                }
              : {})}
            title={building ? building.name : "Agents2"}
            actions={
              !building && types.length > 0 && snapshot.status === "ready" ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="compact"
                    onClick={bringOver}
                    disabled={side === "porting"}
                  >
                    Bring over
                  </Button>
                  <Button size="compact" onClick={newAgent} disabled={creating}>
                    <PlusIcon size={14} aria-hidden="true" /> New agent
                  </Button>
                </div>
              ) : undefined
            }
          />
          <div className="min-h-0 flex-1">{body}</div>
        </div>
      </FullPageSurface>
    </div>
  );
}

/** The grid as one listbox: a single tab stop, arrows move the selection. */
function Inventory({
  agents,
  selected,
  typeOf,
  onSelect,
  onBuild,
}: {
  agents: readonly Agent[];
  selected: string | undefined;
  typeOf(agent: Agent): RegisteredAgentType | undefined;
  onSelect(pubkey?: string): void;
  onBuild(pubkey: string): void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const index = agents.findIndex((agent) => agent.pubkey === selected);
  const columns = () =>
    grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length
      : 1;
  const onKeyDown = (event: KeyboardEvent) => {
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
      ?.querySelectorAll<HTMLElement>('[role="option"]')
      [next]?.focus();
  };
  return (
    <div
      ref={grid}
      role="listbox"
      aria-label="Agents"
      className={styles.grid}
      onKeyDown={onKeyDown}
    >
      {agents.map((agent, position) => {
        const type = typeOf(agent);
        const active = agent.pubkey === selected;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns the keys.
          <div
            key={agent.pubkey}
            role="option"
            aria-selected={active}
            tabIndex={active || (index < 0 && position === 0) ? 0 : -1}
            className={styles.tile}
            data-unavailable={type ? undefined : ""}
            onClick={() => onSelect(active ? undefined : agent.pubkey)}
            onDoubleClick={() => onBuild(agent.pubkey)}
          >
            <span className={styles.portrait}>
              <AgentPortrait agent={agent} size="fill" />
            </span>
            <span className={styles.tileName}>{agent.name}</span>
            <span className={styles.tileSummary}>{summaryOf(agent, type)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** An agent's picture, shown through its community's media access. */
function AgentPortrait({
  agent,
  size,
}: {
  agent: Readonly<{ name: string; picture?: string; relay: string }>;
  size?: "fill";
}) {
  const src = useAvatarPreview(agent.picture ?? "", agent.relay || undefined);
  return (
    <Avatar
      src={src}
      alt=""
      fallback={agent.name}
      {...(size && { size })}
      shape="squircle"
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
  agent,
  type,
  channels,
  onBuild,
  onClose,
}: {
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  onBuild(): void;
  onClose(): void;
}) {
  const Peek = type?.Peek;
  const summary = summaryOf(agent, type);
  return (
    <div className={styles.sideBody}>
      <div className={styles.peekIdentity}>
        <span className={styles.portraitLarge}>
          <AgentPortrait agent={agent} size="fill" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h3 className="m-0 truncate text-heading">{agent.name}</h3>
          <p className="m-0 text-body-sm text-secondary">
            {type?.title ?? "Type unavailable"}
            {type && !Peek && summary !== type.title ? ` · ${summary}` : ""}
          </p>
        </div>
        <IconButton
          aria-label="Close"
          size="sm"
          icon={<XIcon size={16} aria-hidden="true" />}
          onClick={onClose}
        />
      </div>
      <Button variant="primary" onClick={onBuild}>
        Open
      </Button>
      {Peek ? (
        <div className={styles.peekPlugin}>
          <Peek agent={agent} />
        </div>
      ) : !type ? (
        <p className="m-0 text-body-sm text-secondary">
          Enable the plugin that provides this agent's type to run or change it.
        </p>
      ) : null}
      <Section title="Wakes on">
        <AttentionSummary agent={agent} channels={channels} />
      </Section>
    </div>
  );
}

function NewAgent({
  agents2,
  types,
  onClose,
  onCreated,
}: {
  agents2: Agents2;
  types: readonly RegisteredAgentType[];
  onClose(): void;
  onCreated(agent: Agent): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState(types[0]?.key ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const chosen = types.find((item) => item.key === type) ?? types[0];
  const create = async () => {
    if (!chosen || !name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      onCreated(await agents2.create({ type: chosen.key, name: name.trim() }));
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  return (
    <form
      className={styles.sideBody}
      aria-label="New agent"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onClose();
      }}
    >
      <SideHeader
        title={<h3 className="m-0 text-heading">New agent</h3>}
        onClose={onClose}
      />
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Type">
        <RadioGroup
          value={chosen?.key ?? ""}
          disabled={pending}
          onValueChange={(value) => setType(String(value))}
        >
          {types.map((item) => (
            <Radio
              key={item.key}
              value={item.key}
              variant="card"
              label={item.title}
              {...(item.description ? { description: item.description } : {})}
            />
          ))}
        </RadioGroup>
      </Field>
      <p className="m-0 text-body-sm text-secondary">
        It gets its own key on this device and runs while the app is open.
      </p>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        loading={pending}
        disabled={!name.trim() || !chosen}
      >
        Create and set up
      </Button>
    </form>
  );
}

const SOURCES: Record<PortSource, string> = {
  harness: "Buzz 1.0 harness agent",
  installed: "Buzz 0.X",
  development: "Buzz 0.X dev",
};
const host = (relay: string) => relay.replace(/^wss:\/\//, "");

/** Identities earlier agent systems saved on this machine, each brought over
 * with its key, name and picture as an agent of the chosen type. */
function BringOver({
  agents2,
  types,
  onClose,
}: {
  agents2: Agents2;
  types: readonly RegisteredAgentType[];
  onClose(): void;
}) {
  const [found, setFound] = useState<PortableAgents>();
  const [type, setType] = useState(types[0]?.key ?? "");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    agents2.portable().then(
      (next) => live && setFound(next),
      (reason) => live && setError(message(reason)),
    );
    return () => {
      live = false;
    };
  }, [agents2]);
  const chosen = types.find((item) => item.key === type) ?? types[0];
  const labels = publicKeyLabels(found?.agents.map((a) => a.pubkey) ?? []);
  const port = async (agent: PortableAgent) => {
    if (!chosen || pending) return;
    setPending(agent.pubkey);
    setError("");
    try {
      await agents2.port({
        source: agent.source,
        pubkey: agent.pubkey,
        type: chosen.key,
      });
      setFound(
        (last) =>
          last && {
            ...last,
            agents: last.agents.filter((item) => item.pubkey !== agent.pubkey),
          },
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <section className={styles.sideBody} aria-label="Bring over agents">
      <SideHeader
        title={<h3 className="m-0 text-heading">Bring over agents</h3>}
        onClose={onClose}
      />
      <p className="m-0 text-body-sm text-secondary">
        Keeps each agent's key, name and picture in this community. Its
        instructions and settings stay behind. Stop it where it runs now first,
        or both will answer.
      </p>
      <Field label="As">
        <RadioGroup
          value={chosen?.key ?? ""}
          disabled={!!pending}
          onValueChange={(value) => setType(String(value))}
        >
          {types.map((item) => (
            <Radio key={item.key} value={item.key} label={item.title} />
          ))}
        </RadioGroup>
      </Field>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
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
      ) : found.agents.length ? (
        <ul className={styles.portList} aria-label="Agents to bring over">
          {found.agents.map((agent) => (
            <li key={agent.pubkey} className={styles.portRow}>
              <AgentPortrait agent={agent} />
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-body">{agent.name}</span>
                <span className="truncate text-caption text-secondary">
                  {[
                    SOURCES[agent.source],
                    labels.get(agent.pubkey),
                    agent.relay && host(agent.relay),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <Button
                size="compact"
                aria-label={`Bring over ${agent.name}`}
                loading={pending === agent.pubkey}
                disabled={!chosen || (!!pending && pending !== agent.pubkey)}
                onClick={() => void port(agent)}
              >
                Bring over
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-body-sm text-secondary">
          No other agents are saved on this machine.
        </p>
      )}
    </section>
  );
}

function AgentBuild({
  agents2,
  agent,
  type,
  channels,
  onRemoved,
}: {
  agents2: Agents2;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  onRemoved(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [pictureError, setPictureError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className={styles.build}>
      <aside className={styles.rail} aria-label={`${agent.name} identity`}>
        <div className={styles.portraitEdit}>
          <AvatarEditor
            size="compact"
            shape="squircle"
            value={agent.picture ?? ""}
            name={agent.name}
            community={agent.relay}
            onChange={(picture) => {
              setPictureError("");
              agents2
                .save(agent.pubkey, { picture: picture || null })
                .catch((error: unknown) => setPictureError(message(error)));
            }}
          />
          {pictureError && (
            <p role="alert" className="m-0 text-body-sm">
              {pictureError}
            </p>
          )}
        </div>
        <NameField
          name={agent.name}
          onSave={(name) => agents2.save(agent.pubkey, { name })}
        />
        <dl className={styles.facts}>
          <dt>Type</dt>
          <dd>{type?.title ?? "Type unavailable"}</dd>
          <dt>Key</dt>
          <dd className="flex items-center gap-1">
            <code className="truncate">{formatPublicKey(agent.pubkey, 8)}</code>
            <IconButton
              aria-label={copied ? "Copied" : "Copy public key"}
              size="sm"
              icon={<CopyIcon size={14} aria-hidden="true" />}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(agent.pubkey)
                  .then(() => setCopied(true))
              }
            />
          </dd>
        </dl>
        <div className="mt-auto">
          <AgentDelete agents2={agents2} agent={agent} onRemoved={onRemoved} />
        </div>
      </aside>
      <section className={styles.work} aria-label={`${agent.name} settings`}>
        {!type && (
          <p className="m-0 mb-4 text-body-sm text-secondary">
            Enable the plugin that provides this agent's type to change its
            settings. Its attention can still be edited.
          </p>
        )}
        <AgentTabs
          agents2={agents2}
          agent={agent}
          type={type}
          channels={channels}
        />
      </section>
    </div>
  );
}

/** Rename in place: saves on Enter or blur, Escape puts the name back. */
function NameField({
  name,
  onSave,
}: {
  name: string;
  onSave(name: string): Promise<void>;
}) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  // Escape blurs too, and blur saves; this skips that one save.
  const cancelled = useRef(false);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (!next) return setDraft(name);
    if (next === name) return;
    setError("");
    onSave(next).catch((reason) => {
      setError(message(reason));
      setDraft(name);
    });
  };
  return (
    <Field label="Name" labelVisibility="hidden" error={error || undefined}>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            cancelled.current = true;
            setDraft(name);
            event.currentTarget.blur();
            cancelled.current = false;
          }
        }}
      />
    </Field>
  );
}
