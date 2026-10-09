import { npubEncode } from "nostr-tools/nip19";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  ImportSource,
} from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import type { Profile } from "../../features/relay/contracts";
import { communityMedia } from "../../features/profiles/avatar-upload";
import { CaretDownIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";
import type { ProfileResolver } from "./AgentCard";
import {
  ManagedAgentActions,
  useManagedAgentActions,
} from "./ManagedAgentActions";
import { RelayAgentRemove } from "./RelayAgentRemove";
import { Fragment, useState } from "react";
import { AgentArchiveDialog } from "../../features/agents/AgentArchiveDialog";
import {
  type ArchiveAction,
  type ArchiveRun,
  useArchiveConsent,
} from "./inventory-archive";
import {
  localHereGroup,
  relayGroup,
  type inventoryDecision,
} from "./inventory-decisions";
import { type AgentInventoryIdentity, localSetups } from "./inventory-model";

/** One complete inventory identity; source selection belongs to the enclosing inventory. */
export function InventoryIdentityCard({
  row,
  decision,
  community,
  state,
  control,
  session,
  destination,
  publicProfiles,
  sourceProfiles,
  edit,
  duplicate,
  onShare,
  remove,
  removeRelay,
  archive,
  nested = false,
  importedId,
  resolveProfile,
  profileKeys,
  onUseHere,
  onImport,
  selectedSource,
  onSourceChange,
}: {
  row: AgentInventoryIdentity;
  decision: ReturnType<typeof inventoryDecision>;
  community: string;
  state: AgentControlState;
  control: AgentControl;
  session: RelaySession;
  destination: string;
  publicProfiles: ReadonlyMap<string, Profile>;
  sourceProfiles: ReadonlyMap<string, Profile & { community: string }>;
  edit(agent: AgentView, avatar?: string): void;
  duplicate?: ((agent: AgentView) => void) | undefined;
  onShare?: ((agent: AgentView) => void) | undefined;
  remove?: ((agent: AgentView) => void) | undefined;
  /** Undefined when this connection cannot remove relay-only agents. */
  removeRelay?:
    | ((pubkey: string, signal: AbortSignal) => Promise<void>)
    | undefined;
  /** Archive in the connected community; undefined where it does not apply. */
  archive?:
    | {
        archived: boolean;
        community: string;
        run: ArchiveRun | undefined;
        request(action: ArchiveAction): void;
        /** Changes on Refresh agents, to ask for archive permission again. */
        attempt: number;
      }
    | undefined;
  /** True inside the Archived section, one heading level deeper. */
  nested?: boolean;
  importedId: string | null;
  resolveProfile?: ProfileResolver | undefined;
  profileKeys?: ReadonlySet<string> | undefined;
  onUseHere(
    pubkey: string,
    action: "use" | "clone",
    source?: ImportSource,
  ): void;
  onImport(pubkey: string, source?: ImportSource): void;
  selectedSource: ImportSource | undefined;
  onSourceChange(source: ImportSource): void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Archive is per community: offer it only where this identity is known.
  const archivable = useArchiveConsent(
    session.archives,
    row.pubkey,
    !!archive &&
      (row.knownCommunities.has(destination) ||
        row.localSetups.has(destination)),
    archive?.attempt,
  );
  const actions = useManagedAgentActions(state, control);
  const data = state.data;
  if (!data) return null;
  const running = row.localSetups.get(destination)?.status === "running";
  const archiveRun = archive?.run;
  const sourceProfile = sourceProfiles.get(row.pubkey);
  const avatar =
    row.avatar ??
    publicProfiles.get(row.pubkey)?.picture ??
    sourceProfile?.picture;
  const imageCommunity =
    sourceProfile && sourceProfile.picture === avatar
      ? sourceProfile.community
      : undefined;
  const tile = decision.group === localHereGroup;
  // The app runs every saved setup, so each keeps its controls whether or not
  // its community is the one currently selected or connected.
  const setups = localSetups(row, destination);
  const selected = selectedSource;
  const source =
    row.oldBuzzSources.length === 1
      ? row.oldBuzzSources[0]
      : selected && row.oldBuzzSources.includes(selected)
        ? selected
        : undefined;
  const needsSource = !row.localIdentity && row.oldBuzzSources.length > 1;
  const cloneAction = (!!row.localIdentity ||
    row.oldBuzzSources.length > 0) && (
    <Button
      variant="subtle"
      size="compact"
      title="Create a new agent from this agent’s name and instructions, with a new identity and key. Memories and history are not copied."
      disabled={
        state.busy ||
        state.status !== "ready" ||
        (row.localIdentity
          ? !data.localInventoryActions || !control.localCloneSettings
          : !control.cloneSettings) ||
        !destination ||
        (needsSource && !source)
      }
      onClick={() =>
        onUseHere(row.pubkey, "clone", row.localIdentity ? undefined : source)
      }
    >
      Clone
    </Button>
  );
  return (
    <>
      <AgentCard
        layout={tile ? "tile" : "row"}
        headingLevel={((community ? 4 : 3) + (nested ? 1 : 0)) as 3 | 4 | 5}
        name={row.displayName}
        avatar={avatar}
        media={imageCommunity ? communityMedia(imageCommunity) : undefined}
        identities={[{ pubkey: row.pubkey, name: row.displayName }]}
        session={session}
        editable={setups}
        imported={setups.some((agent) => agent.id === importedId)}
        revealControls={setups.some(
          (agent) =>
            agent.id === importedId ||
            !!agent.error ||
            agent.profilePending ||
            !!actions(agent).notice,
        )}
        onViewProfile={
          profileKeys?.has(row.pubkey)
            ? resolveProfile?.(row.pubkey)
            : undefined
        }
        onEdit={setups.length ? edit : undefined}
        onDuplicate={setups.length ? duplicate : undefined}
        onShare={setups.length ? onShare : undefined}
        onDelete={setups.length ? remove : undefined}
        archived={!!archive?.archived}
        archive={
          archive && archivable
            ? {
                archived: archive.archived,
                pending: !!archiveRun && !archiveRun.error,
                onSelect: () =>
                  archive.archived
                    ? archive.request("unarchive")
                    : setConfirming(true),
              }
            : undefined
        }
        feedback={
          archiveRun && (
            <>
              {!archiveRun.error && (
                <p role="status" className="m-0 text-body-sm text-secondary">
                  {archiveRun.action === "archive"
                    ? "Archiving…"
                    : "Unarchiving…"}
                </p>
              )}
              {archive && archiveRun.error && (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p role="alert" className="m-0 text-body-sm text-danger">
                    {archiveRun.action === "archive" ? "Archive" : "Unarchive"}{" "}
                    failed: {archiveRun.error}
                  </p>
                  <Button
                    size="compact"
                    onClick={(event) => {
                      // Retry unmounts while the request runs. Keep focus on
                      // the card's menu button, which stays through success
                      // and failure; success then moves focus with the card.
                      event.currentTarget
                        .closest("article")
                        ?.querySelector<HTMLElement>(
                          'button[aria-label^="Actions for"]',
                        )
                        ?.focus();
                      archive.request(archiveRun.action);
                    }}
                  >
                    Retry
                  </Button>
                </div>
              )}
            </>
          )
        }
      >
        {setups.map((agent) => (
          <Fragment key={agent.id}>
            <ManagedAgentActions
              action={actions(agent)}
              agent={agent}
              // A section already names its own community; other setups still show theirs.
              showCommunity={row.localSetups.get(community) !== agent}
              state={state}
              control={control}
              imported={agent.id === importedId}
            />
          </Fragment>
        ))}
        {row.unconfiguredSetups.map((agent) => (
          <p
            key={agent.id}
            role="status"
            className="m-0 break-all text-body-sm"
          >
            Earlier import needs setup: {agent.relayUrl || "No saved community"}
            . Connect to the intended community and choose Use here. It stays
            stopped.
          </p>
        ))}
        <div
          className={
            tile ? "flex min-w-0 flex-wrap items-center gap-2" : "contents"
          }
        >
          {needsSource && (
            <label className="agent-control-field">
              <span className="sr-only">Old Buzz installation</span>
              <select
                value={source ?? ""}
                disabled={state.busy || state.status !== "ready"}
                onChange={(event) => {
                  const next = event.target.value as ImportSource;
                  onSourceChange(next);
                }}
              >
                <option value="" disabled>
                  Choose an installation
                </option>
                {row.oldBuzzSources.map((value) => (
                  <option key={value} value={value}>
                    {value === "installed"
                      ? "Installed Buzz"
                      : "Development Buzz"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {decision.action === "import" && (
            <Button
              variant="primary"
              size="compact"
              title="Bring this agent into this app with its existing identity and key. It stays stopped in your chosen community until you start it."
              disabled={
                state.busy ||
                state.status !== "ready" ||
                data.importAvailable === false ||
                (needsSource && !source)
              }
              onClick={() => onImport(row.pubkey, source)}
            >
              Import
            </Button>
          )}
          {decision.action === "use" && (
            <>
              <Button
                size="compact"
                disabled={
                  state.busy ||
                  state.status !== "ready" ||
                  !!decision.blocked ||
                  !control.configureHere
                }
                onClick={() => onUseHere(row.pubkey, "use")}
              >
                Use here
              </Button>
              {decision.blocked && <p role="status">{decision.blocked}</p>}
            </>
          )}
          {(tile || decision.action === "clone") && cloneAction}
          {removeRelay &&
            decision.group === relayGroup &&
            // Removal writes to the connected community only.
            (row.knownCommunities.has(destination) ? (
              <RelayAgentRemove
                name={row.displayName}
                remove={(signal) => removeRelay(row.pubkey, signal)}
              />
            ) : (
              <p role="status" className="m-0 text-body-sm text-secondary">
                Switch to this community to remove this agent.
              </p>
            ))}
        </div>
        {decision.action === "wait" && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            {decision.blocked}
          </p>
        )}
        <details
          className={
            tile
              ? "min-w-0 text-body-sm text-secondary"
              : "agent-inventory-details min-w-0 text-body-sm text-secondary"
          }
        >
          <summary
            className="cursor-pointer"
            aria-label={tile ? undefined : `Details for ${row.displayName}`}
          >
            {tile ? (
              "Identity & sources"
            ) : (
              <CaretDownIcon size={18} aria-hidden="true" />
            )}
          </summary>
          <div className="flex min-w-0 flex-col gap-2 pt-2">
            {[...row.knownCommunities]
              .filter(
                (community) => community && !row.localSetups.has(community),
              )
              .map((community) => (
                <p key={community} className="m-0 break-all">
                  {community}
                </p>
              ))}
            {row.oldBuzzSources.length > 0 && (
              <p className="m-0">
                {row.oldBuzzSources
                  .map((source) =>
                    source === "installed"
                      ? "Installed Buzz"
                      : "Development Buzz",
                  )
                  .join(" · ")}
              </p>
            )}
            {!tile && decision.action !== "clone" && cloneAction}
            <p
              className="m-0 select-all break-all text-mono-sm"
              data-public-key=""
            >
              {npubEncode(row.pubkey)}
            </p>
          </div>
        </details>
      </AgentCard>
      {confirming && archive && (
        <AgentArchiveDialog
          name={row.displayName}
          community={archive.community}
          running={running}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            archive.request("archive");
          }}
        />
      )}
    </>
  );
}
