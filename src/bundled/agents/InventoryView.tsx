import { InventoryIdentityCard } from "./InventoryIdentityCard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import type {
  ArchiveAction,
  ArchiveFocus,
  ArchiveRun,
} from "./inventory-archive";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  ImportSource,
} from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import type { Profile } from "../../features/relay/contracts";
import { relayOrigin } from "../../features/communities/destination";
import { AgentCard } from "./AgentCard";
import type { ProfileResolver } from "./AgentCard";
import {
  localHereGroup,
  localOtherGroup,
  relayGroup,
  inventoryDecision,
  inventoryGroups,
} from "./inventory-decisions";
import type { AgentInventoryIdentity } from "./inventory-model";
import type { identityTiles } from "./identity-tiles";

type InventoryEntry = {
  row: AgentInventoryIdentity;
  decision: ReturnType<typeof inventoryDecision>;
};
function communitySections(group: string, identities: InventoryEntry[]) {
  if (group !== localOtherGroup && group !== relayGroup)
    return [{ community: "", identities }];
  const sections = new Map<string, InventoryEntry[]>();
  for (const entry of identities) {
    // A saved setup owns local placement; relay sightings must not move it.
    const communities =
      group === localOtherGroup
        ? [
            ...entry.row.localSetups.keys(),
            ...entry.row.unconfiguredSetups.map((setup) =>
              setup.relayUrl ? relayOrigin(setup.relayUrl) : "",
            ),
          ]
        : [...entry.row.knownCommunities];
    // First sorted community wins, just as the top-level categories do.
    // Keep every setup/association on the one identity row.
    const community = communities.filter(Boolean).sort()[0] ?? "";
    const members = sections.get(community) ?? [];
    members.push(entry);
    sections.set(community, members);
  }
  return [...sections]
    .sort(([a], [b]) => (a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0))
    .map(([community, identities]) => ({
      community: community || "Community unknown",
      identities,
    }));
}

function orderedGroups(entries: InventoryEntry[]) {
  const groups = new Map<string, InventoryEntry[]>();
  for (const entry of entries) {
    const group = entry.decision.group;
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  for (const identities of groups.values()) {
    identities.sort(
      (a, b) =>
        a.row.displayName.localeCompare(b.row.displayName, undefined, {
          sensitivity: "base",
        }) || a.row.pubkey.localeCompare(b.row.pubkey),
    );
  }
  return inventoryGroups.flatMap((group) => {
    const identities = groups.get(group);
    return identities ? [[group, identities] as const] : [];
  });
}

/** Final inventory presentation; discovery and transport lifetime stay with the caller. */
export function InventoryView({
  state,
  control,
  session,
  destination,
  rows,
  profiles,
  publicProfiles,
  sourceProfiles,
  edit,
  duplicate,
  onShare,
  remove,
  removeRelay,
  archive,
  importedId,
  resolveProfile,
  profileKeys,
  onUseHere,
  onImport,
  children,
  teams,
}: {
  state: AgentControlState;
  control: AgentControl;
  session: RelaySession;
  destination: string;
  rows: ReadonlyMap<string, AgentInventoryIdentity>;
  profiles: ReturnType<typeof identityTiles>["profiles"];
  publicProfiles: ReadonlyMap<string, Profile>;
  sourceProfiles: ReadonlyMap<string, Profile & { community: string }>;
  edit(agent: AgentView, avatar?: string): void;
  duplicate?: ((agent: AgentView) => void) | undefined;
  onShare?: ((agent: AgentView) => void) | undefined;
  remove?: ((agent: AgentView) => void) | undefined;
  removeRelay?:
    | ((pubkey: string, signal: AbortSignal) => Promise<void>)
    | undefined;
  /** Archive state and actions for the connected community. */
  archive?:
    | {
        archived: ReadonlySet<string>;
        community: string;
        runs: ReadonlyMap<string, ArchiveRun>;
        request(pubkey: string, action: ArchiveAction): void;
        focus?: (ArchiveFocus & { seq: number }) | undefined;
        attempt: number;
      }
    | undefined;
  importedId: string | null;
  resolveProfile?: ProfileResolver | undefined;
  profileKeys?: ReadonlySet<string> | undefined;
  onUseHere(
    pubkey: string,
    action: "use" | "clone",
    source?: ImportSource,
  ): void;
  onImport(pubkey: string, source?: ImportSource): void;
  children?: ReactNode;
  teams?: ReactNode;
}) {
  const [selectedSources, setSelectedSources] = useState<
    Record<string, ImportSource>
  >({});
  const [archivedOpen, setArchivedOpen] = useState<boolean>();
  const [wasAllArchived, setWasAllArchived] = useState(false);
  const root = useRef<HTMLElement>(null);
  // A confirmed change moves the card; focus follows it to its new place.
  const focus = archive?.focus;
  useEffect(() => {
    if (!focus) return;
    const element = root.current;
    const target = element?.querySelector<HTMLElement>(
      focus.archived
        ? "[data-archived-agents] .buzz-accordion-trigger"
        : `[data-agent-pubkey="${focus.pubkey}"] button[aria-label^="Actions for"]`,
    );
    target?.focus();
  }, [focus]);
  const data = state.data;
  if (!data) return null;
  const active: InventoryEntry[] = [];
  const archived: InventoryEntry[] = [];
  for (const row of rows.values())
    (archive?.archived.has(row.pubkey) ? archived : active).push({
      row,
      decision: inventoryDecision(row, destination),
    });
  const allArchived = !active.length && !!archived.length;
  // Entering the all-archived state reopens the section, even after an
  // earlier collapse; a collapse made while in that state still holds.
  if (allArchived !== wasAllArchived) {
    setWasAllArchived(allArchived);
    if (allArchived) setArchivedOpen(undefined);
  }
  const archivedExpanded = archivedOpen ?? allArchived;
  // Inside the Archived section, groups sit one heading level below its title.
  function renderGroups(entries: InventoryEntry[], nested = false) {
    const GroupHeading = nested ? "h3" : "h2";
    const CommunityHeading = nested ? "h4" : "h3";
    return orderedGroups(entries).map(([group, identities]) => (
      <section key={group} aria-label={group} className="flex flex-col gap-3">
        <GroupHeading className="m-0 text-label-sm">
          {group === localHereGroup ? "Individual agents" : group}
        </GroupHeading>
        {communitySections(group, identities).map(
          ({ community, identities }) => (
            <section
              key={community}
              aria-label={community || undefined}
              className="flex min-w-0 flex-col gap-2"
            >
              {community && (
                <CommunityHeading className="m-0 break-all text-label text-secondary">
                  {community}
                </CommunityHeading>
              )}
              <div
                className={
                  group !== localHereGroup
                    ? `overflow-hidden rounded-xl border border-primary ${group === relayGroup ? "agent-relay-inventory" : ""}`
                    : "agent-grid"
                }
              >
                {identities.map(({ row, decision }) => (
                  <InventoryIdentityCard
                    key={row.pubkey}
                    row={row}
                    decision={decision}
                    community={community}
                    state={state}
                    control={control}
                    session={session}
                    destination={destination}
                    publicProfiles={publicProfiles}
                    sourceProfiles={sourceProfiles}
                    edit={edit}
                    duplicate={duplicate}
                    onShare={onShare}
                    remove={remove}
                    removeRelay={removeRelay}
                    nested={nested}
                    archive={
                      archive && {
                        archived: archive.archived.has(row.pubkey),
                        community: archive.community,
                        run: archive.runs.get(row.pubkey),
                        attempt: archive.attempt,
                        request: (action) =>
                          archive.request(row.pubkey, action),
                      }
                    }
                    importedId={importedId}
                    resolveProfile={resolveProfile}
                    profileKeys={profileKeys}
                    onUseHere={onUseHere}
                    onImport={onImport}
                    selectedSource={selectedSources[row.pubkey]}
                    onSourceChange={(source) =>
                      setSelectedSources((saved) => ({
                        ...saved,
                        [row.pubkey]: source,
                      }))
                    }
                  />
                ))}
              </div>
            </section>
          ),
        )}
      </section>
    ));
  }
  profiles.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  return (
    <section ref={root} aria-label="My agents" className="flex flex-col gap-6">
      {children}
      {!rows.size && <p>No agents yet. Add an agent to get started.</p>}
      {allArchived && <p>All your agents are archived in this community.</p>}
      {renderGroups(
        active.filter((entry) => entry.decision.group === localHereGroup),
      )}
      {teams}
      {renderGroups(
        active.filter((entry) => entry.decision.group !== localHereGroup),
      )}
      {!!archived.length && (
        <section
          aria-label="Archived agents"
          data-archived-agents=""
          className="flex flex-col gap-3"
        >
          <Accordion
            headingLevel={2}
            value={archivedExpanded ? ["archived"] : []}
            onValueChange={(value) =>
              setArchivedOpen(value.includes("archived"))
            }
            items={[
              {
                value: "archived",
                title: `Archived (${archived.length})`,
                content: (
                  <div className="flex flex-col gap-6">
                    {renderGroups(archived, true)}
                  </div>
                ),
              },
            ]}
          />
        </section>
      )}
      {!!profiles.length && (
        <section aria-label="Profiles without identities" className="space-y-3">
          <h2 className="text-heading">Profiles without identities</h2>
          <div className="agent-grid">
            {profiles.map((profile) => (
              <AgentCard
                key={profile.id}
                name={profile.name}
                avatar={profile.avatar}
                identities={[]}
                session={session}
              />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
