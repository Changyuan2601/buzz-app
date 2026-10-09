import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CatalogKind } from "../../features/agents/catalog";
import { sameCommunityAgents } from "../../features/agents/choices";
import type {
  AgentControl,
  AgentView,
  CatalogSeed,
} from "../../features/agents/control";
import {
  AGENT_CATALOG_KIND,
  agentCatalogContent,
  type AgentPublication,
  catalogSlug,
  type CatalogAgent,
  catalogTeamSnapshot,
  TEAM_CATALOG_KIND,
  teamCatalogContent,
  type TeamPublication,
  unsupportedTransport,
  unsupportedTransportMessage,
} from "../../features/agents/catalog-protocol";
import { importTeamSnapshot } from "../../features/agents/team-import";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { Team } from "../../features/channel-templates/model";
import { useIdentityNames } from "../../features/identity-names/react";
import type { RelaySession } from "../../features/relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import styles from "./CommunityCatalog.module.css";

type CommunityCatalog = RelaySession["communityCatalog"];
type Publication = AgentPublication | TeamPublication;

export const agentShareDescription =
  "Anyone in this community can find and use a copy. Your agent instruction is shared as plaintext. Memories and secrets aren’t included.";
export const teamShareDescription =
  "Anyone in this community can find and add a copy of this team. Both the team instructions and every member’s instructions are shared as plaintext. Memories and secrets aren’t included.";

/** Holds the catalog read open for as long as a consumer is mounted. */
export function useCommunityCatalog(catalog: CommunityCatalog) {
  useEffect(() => catalog.retain(), [catalog]);
  return useSyncExternalStore(
    catalog.subscribe,
    catalog.snapshot,
    catalog.snapshot,
  );
}

export function catalogShareNotice(
  name: string,
  change: { shared: boolean; delivery: "queued" | "accepted" },
) {
  if (change.delivery === "queued")
    return change.shared
      ? `Sharing ${name} is queued. It will appear after the relay accepts the update.`
      : `Removing ${name} is queued. It may remain discoverable until the relay accepts the update.`;
  return change.shared
    ? `Published ${name} to the community catalog.`
    : `${name} is no longer discoverable in the community catalog.`;
}

const message = (problem: unknown) =>
  problem instanceof Error ? problem.message : String(problem);

/** One coordinate's share switch. The switch shows the newest intent; the
 * notice distinguishes a queued, accepted or refused relay delivery. */
export function CatalogShareSwitch({
  catalog,
  kind,
  d,
  name,
  description,
  content,
  onPendingChange,
}: {
  catalog: CommunityCatalog;
  kind: CatalogKind;
  d: string;
  name: string;
  description: string;
  /** Projects the current local definition; may refuse with a reason. */
  content(): string | Promise<string>;
  /** Lets a containing dialog stay open while the projection is pending. */
  onPendingChange?(pending: boolean): void;
}) {
  const snapshot = useCommunityCatalog(catalog);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // A projection that settles after this switch is gone must not publish:
  // a newer intent for the same coordinate may already have been recorded.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { shared, change } = catalog.state(kind, d);
  const rejected = change?.delivery === "rejected";
  const checked = change && !rejected ? change.shared : shared;
  // A confirmation Retry stays mounted, busy, while its re-read runs.
  const [checking, setChecking] = useState<string>();
  const confirming =
    !!change &&
    checking === change.operation &&
    change.delivery === "queued" &&
    !change.stalled;
  // A notice control removed while focused hands focus to the switch.
  // Sibling controls can leave in the same commit, so any focused removal
  // claims the handoff; the layout effect below resets it.
  const toggle = useRef<HTMLButtonElement>(null);
  const handoff = useRef(false);
  const notice = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      handoff.current ||= document.activeElement === button;
    };
  }, []);
  useLayoutEffect(() => {
    if (!handoff.current) return;
    handoff.current = false;
    if (document.activeElement === document.body)
      toggle.current?.focus({ preventScroll: true });
  });
  const busy = (next: boolean) => {
    setPending(next);
    onPendingChange?.(next);
  };
  const update = async (next: boolean) => {
    setError(undefined);
    busy(true);
    try {
      const text = next ? await content() : undefined;
      if (!mounted.current) return;
      await catalog.publish(kind, d, next, text, () => mounted.current);
    } catch (problem) {
      if (mounted.current) setError(message(problem));
    } finally {
      if (mounted.current) busy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SwitchPreferenceRow
        ref={toggle}
        label="Share to catalog"
        description={description}
        checked={checked}
        disabled={pending || snapshot.status !== "ready" || !catalog.writable()}
        onCheckedChange={(next) => void update(next)}
      />
      {snapshot.status === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-body-sm">{snapshot.error}</p>
          <Button
            ref={notice}
            size="compact"
            onClick={() => void catalog.refresh()}
          >
            Retry
          </Button>
        </div>
      )}
      {change && change.delivery !== "rejected" && (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-body-sm">
            {catalogShareNotice(name, {
              shared: change.shared,
              delivery: change.delivery,
            })}
            {change.stalled && change.error && ` ${change.error}`}
          </p>
          {(change.stalled || confirming) && (
            <Button
              ref={notice}
              size="compact"
              loading={confirming}
              onClick={() => {
                setChecking(change.operation);
                catalog.retry(change.operation);
              }}
            >
              Retry
            </Button>
          )}
          {(change.delivery === "accepted" || change.stalled || confirming) && (
            <Button
              ref={notice}
              size="compact"
              variant="ghost"
              onClick={() => void catalog.dismiss(change.operation)}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
      {(error || rejected) && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="m-0 break-words text-body-sm">
            Failed to update catalog sharing.
            {(error ?? change?.error) && ` ${error ?? change?.error}`}
          </p>
          {rejected && !error && (
            <>
              <Button
                ref={notice}
                size="compact"
                onClick={() => catalog.retry(change.operation)}
              >
                Retry
              </Button>
              <Button
                ref={notice}
                size="compact"
                variant="ghost"
                onClick={() => void catalog.dismiss(change.operation)}
              >
                Dismiss
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Sharing applies to the connected community's setup of this identity. */
export function AgentShareSwitch({
  session,
  agent,
  name,
  defaultSessionPolicy,
}: {
  session: RelaySession;
  agent: AgentView;
  name: string;
  /** The agent defaults an inheriting agent runs with. */
  defaultSessionPolicy: "channel" | "thread" | undefined;
}) {
  if (!sameCommunityAgents([agent], session.scope).length) return null;
  return (
    <CatalogShareSwitch
      catalog={session.communityCatalog}
      kind={AGENT_CATALOG_KIND}
      d={catalogSlug(agent.pubkey)}
      name={name}
      description={agentShareDescription}
      content={() => agentCatalogContent(agent, defaultSessionPolicy)}
    />
  );
}

/** The team's saved portable metadata, read and validated through the same
 * owners Export and Deploy use. A team that has a portable definition
 * refuses to share without it rather than publishing a lossy copy. */
async function portableTeamText(
  kit: Pick<ChannelKit, "loadTeam">,
  control: AgentControl,
  team: Team,
) {
  if (!team.portable) return {};
  const loaded = await kit.loadTeam(team);
  if (!control.previewTeam) throw new Error("Team preview is unavailable");
  const { description, instructions } = (
    await control.previewTeam(JSON.stringify(loaded))
  ).team;
  return { description, instructions };
}

/** Complete catalog projection shared by the catalog and direct-share dialogs. */
export async function buildTeamCatalogContent(
  session: RelaySession,
  control: AgentControl,
  kit: Pick<ChannelKit, "loadTeam">,
  team: Team,
) {
  const text = await portableTeamText(kit, control, team);
  const data = control.snapshot().data;
  return teamCatalogContent(
    { ...team, ...text },
    sameCommunityAgents(data?.agents ?? [], session.scope),
    data?.defaultSettings?.sessionPolicy,
  );
}

/** A saved team's catalog switch. Its members are projected from this
 * community's local agent definitions when sharing, never from relay data. */
export function TeamShareDialog({
  session,
  control,
  kit,
  team,
  onClose,
}: {
  session: RelaySession;
  control: AgentControl;
  kit: Pick<ChannelKit, "loadTeam">;
  team: Team;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      preventClose={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Share ${team.name}`}
    >
      <CatalogShareSwitch
        onPendingChange={setPending}
        catalog={session.communityCatalog}
        kind={TEAM_CATALOG_KIND}
        d={team.id}
        name={team.name}
        description={teamShareDescription}
        content={() => buildTeamCatalogContent(session, control, kit, team)}
      />
    </Dialog>
  );
}

const coordinate = (publication: Publication) =>
  `${publication.kind}:${publication.owner}:${publication.d}`;
const addedKey = (scope: string, viewer: string) =>
  `buzz.catalog-added.v2:${JSON.stringify([scope, viewer])}`;

/** The local copy each catalog coordinate produced for this viewer in this
 * community. Only a hint: an adopted copy is independent of the entry. */
export function addedCopies(
  scope: string,
  viewer: string,
): ReadonlyMap<string, string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(addedKey(scope, viewer)) ?? "{}",
    );
    return new Map(
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          )
        : [],
    );
  } catch {
    return new Map();
  }
}
export function catalogAlreadyAdded(
  session: RelaySession,
  publication: Publication,
  hasCopy: (id: string) => boolean,
): boolean {
  if (publication.owner === session.viewer) return true;
  const copy = addedCopies(session.scope, session.viewer ?? "").get(
    coordinate(publication),
  );
  return copy !== undefined && hasCopy(copy);
}
export function rememberAdded(
  scope: string,
  viewer: string,
  publication: Publication,
  copy: string,
) {
  const added = new Map(addedCopies(scope, viewer));
  added.set(coordinate(publication), copy);
  try {
    localStorage.setItem(
      addedKey(scope, viewer),
      JSON.stringify(Object.fromEntries(added)),
    );
  } catch {
    /* The copy exists either way; only the Added hint is lost. */
  }
}

/** The portable create seed; the create form resolves the runtime locally. */
export function catalogSeed(agent: CatalogAgent): CatalogSeed {
  return {
    origin: "catalog",
    name: agent.displayName,
    systemPrompt: agent.systemPrompt,
    sessionPolicy: agent.sessionPolicy,
    ...(agent.runtime ? { runtime: agent.runtime } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.avatarUrl ? { picture: agent.avatarUrl } : {}),
  };
}

/** Adds a fresh copy of a listed team through the shared team importer,
 * after confirming the previewed head is still the shared head. Catalog
 * teams carry no memories or allowlists, and nothing is started. */
export async function adoptCatalogTeam(
  session: RelaySession,
  control: AgentControl,
  destination: string,
  owner: string,
  listed: TeamPublication,
): Promise<string> {
  const team = await session.communityCatalog.currentTeam(listed);
  const alias = unsupportedTransport(team);
  if (alias) throw new Error(unsupportedTransportMessage(team.name, alias));
  const result = await importTeamSnapshot(
    control,
    session.channelKit,
    catalogTeamSnapshot(team),
    { destination, owner, keepAllowlist: false, restoreMemory: false },
  );
  return result.id;
}

/** The Add dialog's catalog browser. An added agent goes through the
 * ordinary create flow, so its copy has a fresh identity and local keys. */
export function CatalogLauncher({
  session,
  addAgent,
  hasAgent,
  control,
  destination,
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
  session: RelaySession;
  addAgent:
    | ((settings: CatalogSeed, onCreated: (agent: AgentView) => void) => void)
    | undefined;
  /** Whether a local agent still exists; a deleted copy can be added again. */
  hasAgent(id: string): boolean;
  /** Team adoption goes through the shared team importer. */
  control?: AgentControl | undefined;
  destination?: string | undefined;
}) {
  if (!session.communityCatalog.available()) return null;
  const kit = session.channelKit;
  const owner = session.viewer;
  const hasTeam = (id: string) =>
    kit
      .snapshot()
      .entries.some(
        (entry) =>
          entry.record.value.type === "team" && entry.record.value.id === id,
      );
  return open ? (
    <CommunityCatalogDialog
      session={session}
      onClose={onClose}
      hasCopy={(publication, id) =>
        publication.kind === AGENT_CATALOG_KIND ? hasAgent(id) : hasTeam(id)
      }
      onAddTeam={
        control?.previewTeam && kit.available && destination && owner
          ? (listed) =>
              adoptCatalogTeam(session, control, destination, owner, listed)
          : undefined
      }
      onAddAgent={
        addAgent &&
        ((publication) => {
          onClose();
          addAgent(catalogSeed(publication.agent), (agent) =>
            rememberAdded(
              session.scope,
              session.viewer ?? "",
              publication,
              agent.id,
            ),
          );
        })
      }
    />
  ) : null;
}

/** Browse and preview shared agents and teams. Preview renders plain data
 * only; adding is the caller's explicit, separately confirmed act. */
export function CommunityCatalogDialog({
  session,
  onClose,
  hasCopy,
  onAddAgent,
  onAddTeam,
}: {
  session: RelaySession;
  onClose(): void;
  /** Whether the local copy an earlier add produced still exists. */
  hasCopy(publication: Publication, id: string): boolean;
  onAddAgent?: ((publication: AgentPublication) => void) | undefined;
  /** Resolves with the local team copy's ID. */
  onAddTeam?: ((publication: TeamPublication) => Promise<string>) | undefined;
}) {
  const catalog = session.communityCatalog;
  const snapshot = useCommunityCatalog(catalog);
  const resolve = useIdentityNames(session.names);
  const scope = session.scope;
  const viewer = session.viewer ?? "";
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const entries: Publication[] = [...snapshot.agents, ...snapshot.teams];
  const current =
    entries.find((entry) => coordinate(entry) === selected) ?? entries[0];
  const own = (entry: Publication) => entry.owner === session.viewer;
  const isAdded = (entry: Publication) =>
    catalogAlreadyAdded(session, entry, (id) => hasCopy(entry, id));
  const owner = (entry: Publication) =>
    own(entry) ? "You" : resolve(entry.owner, "Community member");
  const picture = (url?: string) => avatarMedia(url, session.media);
  const transport = current && unsupportedTransport(current);
  const addTeam = async (team: TeamPublication) => {
    if (!onAddTeam) return;
    setError(undefined);
    setAdding(true);
    try {
      const copy = await onAddTeam(team);
      rememberAdded(scope, viewer, team, copy);
    } catch (problem) {
      setError(message(problem));
    } finally {
      setAdding(false);
    }
  };
  const loading =
    !entries.length &&
    (snapshot.status === "loading" || snapshot.status === "idle");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      preventClose={adding}
      title="Community Catalog"
      size="wide"
      height="stable"
      actions={
        current?.kind === AGENT_CATALOG_KIND
          ? onAddAgent && (
              <Button
                variant="prominent"
                aria-label={
                  isAdded(current)
                    ? `${current.agent.displayName} is already in My Agents`
                    : `Add ${current.agent.displayName} from Community Catalog`
                }
                disabled={isAdded(current) || adding || !!transport}
                onClick={() => {
                  if (!adding) onAddAgent(current);
                }}
              >
                {isAdded(current) ? "Added to My Agents" : "Add agent"}
              </Button>
            )
          : current &&
            onAddTeam && (
              <Button
                variant="prominent"
                aria-label={
                  isAdded(current)
                    ? `${current.name} is already in your teams`
                    : `Add ${current.name} from Community Catalog`
                }
                disabled={isAdded(current) || adding || !!transport}
                onClick={() => void addTeam(current)}
              >
                {isAdded(current)
                  ? "Added to my teams"
                  : adding
                    ? "Adding…"
                    : "Add team"}
              </Button>
            )
      }
    >
      {loading ? (
        <p role="status">Loading the community catalog…</p>
      ) : snapshot.status === "error" ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="m-0">{snapshot.error}</p>
          <Button onClick={() => void catalog.refresh()}>Retry</Button>
        </div>
      ) : !current ? (
        <div className="flex flex-col gap-1 text-center">
          <p className="m-0 text-label">Nothing shared yet</p>
          <p className="m-0 text-body-sm text-secondary">
            Shared agents and teams will appear here.
          </p>
        </div>
      ) : (
        <div className={styles.catalog}>
          <nav aria-label="Community Catalog" className={styles.sidebar}>
            {!!snapshot.agents.length && (
              <p className="m-0 text-label-sm text-secondary">Agents</p>
            )}
            {snapshot.agents.map((entry) => (
              <NavigationItem
                key={coordinate(entry)}
                selected={entry === current}
                aria-current={entry === current ? "true" : undefined}
                onClick={() => setSelected(coordinate(entry))}
                icon={
                  <Avatar
                    size="small"
                    src={picture(entry.agent.avatarUrl)}
                    alt=""
                    fallback={entry.agent.displayName}
                  />
                }
                label={entry.agent.displayName}
              />
            ))}
            {!!snapshot.teams.length && (
              <p className="m-0 text-label-sm text-secondary">Teams</p>
            )}
            {snapshot.teams.map((entry) => (
              <NavigationItem
                key={coordinate(entry)}
                selected={entry === current}
                aria-current={entry === current ? "true" : undefined}
                onClick={() => setSelected(coordinate(entry))}
                label={entry.name}
                trailing={entry.members.length}
              />
            ))}
          </nav>
          <section
            aria-label={
              current.kind === AGENT_CATALOG_KIND
                ? current.agent.displayName
                : current.name
            }
            className={`${styles.details} flex flex-col gap-6`}
          >
            {current.kind === AGENT_CATALOG_KIND ? (
              <>
                <div className="flex items-center gap-3">
                  <Avatar
                    size="large"
                    src={picture(current.agent.avatarUrl)}
                    alt=""
                    fallback={current.agent.displayName}
                  />
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-heading">
                      {current.agent.displayName}
                    </h3>
                    <AddedBy label={owner(current)} />
                  </div>
                </div>
                {current.agent.description && (
                  <p className="m-0 text-body-sm text-secondary">
                    {current.agent.description}
                  </p>
                )}
                <Metadata agent={current.agent} />
                <div className="flex flex-col gap-2">
                  <h4 className="m-0 text-label">Agent instructions</h4>
                  <Instructions text={current.agent.systemPrompt} />
                </div>
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <h3 className="m-0 truncate text-heading">{current.name}</h3>
                  <AddedBy label={owner(current)} />
                  {current.description && (
                    <p className="mt-3 mb-0 text-body-sm text-secondary">
                      {current.description}
                    </p>
                  )}
                </div>
                {!!current.instructions?.trim() && (
                  <div className="flex flex-col gap-2">
                    <h4 className="m-0 text-label">Team instructions</h4>
                    <Instructions text={current.instructions} />
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <h4 className="m-0 text-label">
                    {current.members.length}{" "}
                    {current.members.length === 1 ? "member" : "members"}
                  </h4>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {current.members.map((member) => (
                      <Member
                        key={member.memberKey}
                        member={member}
                        picture={picture(member.avatarUrl)}
                      />
                    ))}
                  </ul>
                </div>
              </>
            )}
            {transport && !isAdded(current) && (
              <p role="note" className="m-0 break-words text-body-sm">
                {unsupportedTransportMessage(
                  current.kind === AGENT_CATALOG_KIND
                    ? current.agent.displayName
                    : current.name,
                  transport,
                )}
              </p>
            )}
            {error && (
              <p role="alert" className="m-0 break-words text-body-sm">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** The existing catalog preview is reusable inside the Add surface. */
export function AgentCatalogPreview({
  publication,
  session,
}: {
  publication: AgentPublication;
  session: RelaySession;
}) {
  const agent = publication.agent;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Avatar
          size="large"
          src={avatarMedia(agent.avatarUrl, session.media)}
          alt=""
          fallback={agent.displayName}
        />
        <div>
          <h3 className="m-0 text-heading">{agent.displayName}</h3>
          <AddedBy
            label={
              publication.owner === session.viewer
                ? "You"
                : publication.owner.slice(0, 12)
            }
          />
        </div>
      </div>
      {agent.description && (
        <p className="m-0 text-body-sm text-secondary">{agent.description}</p>
      )}
      <Metadata agent={agent} />
      <div className="flex flex-col gap-2">
        <h4 className="m-0 text-label">Agent instructions</h4>
        <Instructions text={agent.systemPrompt} />
      </div>
    </div>
  );
}

export function TeamCatalogPreview({
  publication,
  session,
}: {
  publication: TeamPublication;
  session: RelaySession;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="m-0 text-heading">{publication.name}</h3>
        {publication.description && <p>{publication.description}</p>}
      </div>
      {publication.instructions && (
        <div>
          <h4 className="text-label">Team instructions</h4>
          <Instructions text={publication.instructions} />
        </div>
      )}
      <div>
        <h4 className="text-label">{publication.members.length} members</h4>
        <ul className="m-0 list-none p-0">
          {publication.members.map((member) => (
            <Member
              key={member.memberKey}
              member={member}
              picture={avatarMedia(member.avatarUrl, session.media)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function AddedBy({ label }: { label: string }) {
  return (
    <p className="m-0 text-body-sm text-secondary">
      Added by <span className="text-primary">{label}</span>
    </p>
  );
}

function Metadata({ agent }: { agent: CatalogAgent }) {
  const items = [
    ["Type", "Custom agent"],
    ["Preferred model", agent.model ?? "Use app default"],
    ["Preferred runtime", agent.runtime ?? "Use app default"],
    ["Preferred provider", agent.provider ?? "Use app default"],
  ];
  return (
    <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-body-sm text-secondary">{label}</dt>
          <dd className="m-0 break-words text-body-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Exact instructions as plain text: Markdown would hide link targets and
 * image sources, so the reviewed text could differ from what runs. */
function Instructions({ text }: { text: string }) {
  return (
    <pre className={`${styles.instructions} text-body-sm`}>
      {text || "No instructions included."}
    </pre>
  );
}

function Member({
  member,
  picture,
}: {
  member: TeamPublication["members"][number];
  picture: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="flex flex-col gap-3">
      <Button
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Avatar
          size="small"
          src={picture}
          alt=""
          fallback={member.displayName}
        />
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="truncate">{member.displayName}</span>
          <span className="truncate text-body-sm text-secondary">
            {member.model ?? "Use app default"}
          </span>
        </span>
        <CaretDownIcon size={16} aria-hidden="true" />
      </Button>
      {expanded && (
        <div className="flex flex-col gap-3 pl-2">
          <Metadata agent={member} />
          <div className="flex flex-col gap-2">
            <h5 className="m-0 text-label-sm">Agent instructions</h5>
            {member.systemPrompt.trim() ? (
              <Instructions text={member.systemPrompt} />
            ) : (
              <p className="m-0 text-body-sm text-secondary">No instructions</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
