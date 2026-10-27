// Browse: the agents this community's members have shared, each importable
// as a new agent. The catalog is read a page at a time; an over-budget page is
// retried smaller.
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { AGENT_CATALOG_KIND } from "../../features/agents/catalog-envelope";
import { ModelIcon } from "../../features/agents/ModelPicker";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  type SharedAgent,
  sharedAgents,
} from "../../features/agents/shared-agents";
import { ReadError } from "../../features/relay/errors";
import type { EventData } from "../../features/relay/events";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Select } from "../../shared/design-system/ui/Select";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  canonicalPublicKey,
  formatPublicKey,
} from "../../shared/identity/public-key";
import { AgentCardBackdrop, AgentPortrait } from "./AgentCard";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import { agentAvatars } from "../../features/agents/avatar-packs";
import hero from "../../features/profiles/ProfileHero.module.css";
import pageStyles from "./AgentsPage.module.css";
import cardStyles from "./AgentCard.module.css";
import styles from "./AgentBrowse.module.css";

const pageSize = 200;

type Importing = Readonly<{
  agents: Agents;
  /** The types an import can be, which run on this computer. */
  types: readonly RegisteredAgentType[];
  onImported(): void;
}>;

export type SharedAgentSelection = {
  agent: SharedAgent;
  session: RelaySession;
  community: string | undefined;
};
type Selection = {
  selectedId?: string | undefined;
  onSelect(selection: SharedAgentSelection, trigger: HTMLButtonElement): void;
};

export function AgentBrowse({
  relay,
  ...selection
}: Selection & { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready")
    return <p>Connect to a community to browse shared agents.</p>;
  // A new session (another community) starts over from the first page.
  return (
    <SharedAgentList
      key={connection.generation}
      session={connection.session}
      community={connection.origin}
      {...selection}
    />
  );
}

function SharedAgentList({
  session,
  community,
  selectedId,
  onSelect,
}: Selection & {
  session: RelaySession;
  community: string | undefined;
}) {
  const [events, setEvents] = useState<readonly EventData[]>([]);
  const [cursor, setCursor] = useState<{ until: number; before_id: string }>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry reruns this finite read.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const readPage = async () => {
      let limit = pageSize;
      for (;;) {
        controller.signal.throwIfAborted();
        try {
          const page = await session.read(
            [{ kinds: [AGENT_CATALOG_KIND], limit, ...cursor }],
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          setEvents((previous) => (cursor ? [...previous, ...page] : page));
          setMore(page.length === limit);
          return;
        } catch (problem) {
          // Match the community catalog's bounded retry at the same cursor.
          if (
            problem instanceof ReadError &&
            problem.kind === "invalid-response" &&
            problem.message === "Relay response exceeds the read budget" &&
            limit > 1
          ) {
            limit = Math.floor(limit / 2);
            continue;
          }
          throw problem;
        }
      }
    };
    void readPage()
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session, cursor, attempt]);
  const agents = sharedAgents(events);
  return (
    <div className="flex flex-col gap-section-gap">
      {loading && <p role="status">Loading shared agents…</p>}
      {error && (
        <div role="alert">
          <p>Couldn’t load shared agents.</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      )}
      {!loading && !error && !agents.length && (
        <p>No shared agents found in this community yet.</p>
      )}
      <div className={cardStyles.grid}>
        {agents.map((agent) => (
          <SurfaceButton
            key={agent.id}
            className={`${cardStyles.card} ${cardStyles.agentCard}`}
            aria-label={agent.name}
            aria-current={selectedId === agent.id || undefined}
            data-selected={selectedId === agent.id || undefined}
            onClick={(event) =>
              onSelect({ agent, session, community }, event.currentTarget)
            }
          >
            <AgentCardBackdrop agent={agent} community={community} />
            <span className={cardStyles.portrait} aria-hidden="true">
              <AgentPortrait agent={agent} community={community} />
            </span>
            <span className={cardStyles.identity}>
              <span className={`${cardStyles.name} text-label`}>
                {agent.name}
              </span>
              <span className={cardStyles.detail}>
                <ModelIcon model={agent.model} />
                <span className={cardStyles.detailText}>
                  {agent.model || "Shared agent"}
                </span>
              </span>
            </span>
          </SurfaceButton>
        ))}
      </div>
      {more && !error && (
        <Button
          disabled={loading}
          onClick={() => {
            const last = [...events]
              .sort(
                (a, b) =>
                  b.created_at - a.created_at || a.id.localeCompare(b.id),
              )
              .at(-1);
            if (last) setCursor({ until: last.created_at, before_id: last.id });
          }}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

export function SharedAgentPanel({
  selection,
  ...importing
}: Importing & { selection: SharedAgentSelection }) {
  const { agent, session, community } = selection;
  const pack = agentAvatars.find((item) => item.url === agent.picture);
  const picture = useAvatarPreview(
    pack ? "" : (agent.picture ?? ""),
    community,
    "small",
  );
  const backdrop = pack?.preview ?? picture;
  return (
    <div className={pageStyles.detailsScroll}>
      <section
        className={`${hero.hero} ${hero.panelHero}`}
        aria-label={`${agent.name} identity`}
      >
        <ProfileBackdrop src={backdrop} />
        <span className={pageStyles.identityPortrait}>
          <AgentPortrait agent={agent} community={community} />
        </span>
        <h2 className="m-0 text-heading text-center break-words">
          {agent.name}
        </h2>
        <div className={hero.actions}>
          <ImportShared
            key={agent.id}
            shared={agent}
            variant={backdrop ? "glass" : "subtle"}
            {...importing}
          />
        </div>
      </section>
      <section>
        <InlineHeader title="About" />
        <SettingsGroup>
          <PreferenceRow
            title="Shared by"
            trailing={
              <Sharer
                pubkey={agent.owner}
                session={session}
                community={community}
              />
            }
          />
          <PreferenceRow
            title="Model"
            trailing={
              <span className={styles.fact}>
                <ModelIcon model={agent.model} />
                {agent.model || "Not given"}
              </span>
            }
          />
        </SettingsGroup>
      </section>
      <SharedAgentDetails agent={agent} />
    </div>
  );
}

function SharedAgentDetails({ agent }: { agent: SharedAgent }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const long =
    agent.instructions.length > 320 ||
    agent.instructions.split("\n").length > 5;
  return (
    <div className={styles.details}>
      <InlineHeader title="Instructions" />
      <section
        id={id}
        className={styles.instructions}
        data-collapsed={long && !expanded ? "" : undefined}
        aria-label="Instructions"
      >
        {agent.instructions || "No instructions included."}
      </section>
      {long && (
        <div className={styles.instructionsAction}>
          <Button
            variant="subtle"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "See less" : "See more"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Who shared it, by their profile; the key itself is a hover away. */
function Sharer({
  pubkey,
  session,
  community,
}: {
  pubkey: string;
  session: RelaySession;
  community: string | undefined;
}) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  useEffect(() => {
    void session.profiles.ensure([pubkey]).catch(() => {});
  }, [session, pubkey]);
  const profile = profiles.get(pubkey);
  const picture = useAvatarPreview(profile?.picture ?? "", community, "small");
  const npub = canonicalPublicKey(pubkey) ?? pubkey;
  const name =
    profile && !profile.nameIsFallback
      ? profile.name
      : (formatPublicKey(pubkey) ?? pubkey);
  return (
    <Tooltip content={npub}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to the key in the tooltip.
        tabIndex={0}
        className={styles.fact}
      >
        <Avatar src={picture} alt="" fallback={name} size="small" />
        <span className="truncate">{name}</span>
      </span>
    </Tooltip>
  );
}

/** The panel keeps one action; configuration belongs to the import dialog. */
function ImportShared({
  variant,
  ...props
}: Importing & { shared: SharedAgent; variant: "glass" | "subtle" }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        variant={variant}
        size="sm"
        shape="control"
        onClick={() => setOpen(true)}
      >
        Import
      </Button>
      {open && (
        <SharedImportDialog
          {...props}
          onClose={() => setOpen(false)}
          finalFocus={trigger}
        />
      )}
    </>
  );
}

function SharedImportDialog({
  shared,
  agents,
  types,
  onImported,
  onClose,
  finalFocus,
}: Importing & {
  shared: SharedAgent;
  onClose(): void;
  finalFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const [initial] = useState(() => {
    for (const type of types) {
      const config = type.importShared?.(shared);
      if (config !== undefined) return { key: type.key, config };
    }
    return undefined;
  });
  const [type, setType] = useState(initial?.key ?? "");
  const [config, setConfig] = useState<unknown>(initial?.config);
  const [changing, setChanging] = useState(!initial);
  const form = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const chosen = types.find((item) => item.key === type);
  const Model = chosen?.CreateModel;
  const choose = (key: string) => {
    const next = types.find((item) => item.key === key);
    setType(key);
    setConfig(next?.importShared?.(shared) ?? next?.defaults().config);
  };
  const run = async () => {
    if (!chosen || pending) return;
    setPending(true);
    setError("");
    try {
      await agents.port({
        source: "shared",
        type: chosen.key,
        name: shared.name,
        ...(shared.picture ? { picture: shared.picture } : {}),
        instructions: shared.instructions,
        ...(config !== undefined ? { config } : {}),
      });
      onImported();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title={`Import ${shared.name}`}
      finalFocus={finalFocus}
      preventClose={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!chosen || pending}
            loading={pending}
            onClick={() => void run()}
          >
            Import
          </Button>
        </>
      }
    >
      <div ref={form} className="grid gap-4">
        {types.length === 0 && (
          <p className="m-0 text-body-sm text-secondary">
            Enable an agent type plugin to import agents.
          </p>
        )}
        {initial && !changing ? (
          <>
            <SettingsGroup>
              <PreferenceRow title="Import as" trailing={chosen?.title} />
              {shared.provider && (
                <PreferenceRow title="Provider" trailing={shared.provider} />
              )}
              <PreferenceRow
                title="Model"
                trailing={shared.model || "Default"}
              />
            </SettingsGroup>
            <Button
              variant="ghost"
              onClick={() => {
                // The button goes with the summary; keep focus on what replaces it.
                flushSync(() => setChanging(true));
                form.current
                  ?.querySelector<HTMLElement>("[role='combobox']")
                  ?.focus();
              }}
            >
              Change settings
            </Button>
          </>
        ) : (
          types.length > 0 && (
            <>
              <Select
                variant="field"
                label="Import as"
                placeholder="Choose an agent type"
                value={type}
                disabled={pending}
                groups={[
                  {
                    label: "Agent types",
                    options: types.map((item) => ({
                      value: item.key,
                      label: item.title,
                    })),
                  },
                ]}
                onValueChange={choose}
              />
              {Model && (
                <SettingsGroup>
                  <PreferenceRow
                    title="Model"
                    trailing={
                      <Model
                        key={type}
                        config={config}
                        disabled={pending}
                        onChange={setConfig}
                      />
                    }
                  />
                </SettingsGroup>
              )}
            </>
          )
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
