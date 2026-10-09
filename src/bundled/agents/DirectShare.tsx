import { useState } from "react";
import type { AgentControl, AgentView } from "../../features/agents/control";
import { useAgentControl } from "../../features/agents/control-react";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
  type MemoryLevel,
} from "../../features/agents/snapshot";
import { SnapshotShareDialog } from "../../features/agents/SnapshotShareDialog";
import { copySnapshotLink } from "../../features/agents/snapshot-link";
import { encodeTeam } from "../../features/agents/team-encoding";
import type { RelaySession } from "../../features/relay/session";
import type { Team } from "../../features/channel-templates/model";
import type { ChannelKit } from "../../features/channel-templates/capability";
import { messageViewKey } from "../../features/messages/view-key";
import { relayOrigin } from "../../features/communities/destination";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentSnapshotExport } from "./AgentSnapshots";
import { TeamExportDialog } from "./TeamExportDialog";
import {
  AgentShareSwitch,
  CatalogShareSwitch,
  teamShareDescription,
  buildTeamCatalogContent,
} from "./CommunityCatalog";
import { TEAM_CATALOG_KIND } from "../../features/agents/catalog-protocol";
import { sameCommunityAgents } from "../../features/agents/choices";

const unusedCatalog = {
  shared: false,
  description: "",
  setShared: async () => {},
};

export function AgentDirectShare({
  session,
  agent,
  control,
  name,
  open: externalOpen,
  onClose,
}: {
  open?: boolean;
  onClose?: () => void;
  session: RelaySession;
  agent: AgentView;
  control: AgentControl;
  name: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = externalOpen ?? internalOpen;
  const close = onClose ?? (() => setInternalOpen(false));
  const state = useAgentControl(control);
  const current = state.data?.agents.find((value) => value.id === agent.id);
  let review: ReturnType<typeof buildAgentSnapshot> | undefined;
  try {
    if (current)
      review = buildAgentSnapshot(
        current,
        "none",
        [],
        state.data?.defaultSettings?.sessionPolicy,
      );
  } catch {
    // The mounted contents report the owner's validation error.
  }
  return (
    <>
      {externalOpen === undefined && (
        <Button onClick={() => setInternalOpen(true)}>Share</Button>
      )}
      {open && current && (
        <AgentShareContents
          key={messageViewKey(
            session,
            JSON.stringify([
              current.id,
              current.pubkey,
              current.relayUrl,
              review,
            ]),
          )}
          session={session}
          agent={current}
          name={name}
          control={control}
          close={close}
        />
      )}
    </>
  );
}

function AgentShareContents({
  session,
  agent,
  name,
  control,
  close,
}: {
  session: RelaySession;
  agent: AgentView;
  name: string;
  control: AgentControl;
  close(): void;
}) {
  const [exporting, setExporting] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const destination = relayOrigin(
    session.scope.slice(0, -((session.viewer?.length ?? 0) + 1)),
  );
  const hasMemoryOptions =
    sameCommunityAgents([agent], session.scope).length > 0;
  const policy = control.snapshot().data?.defaultSettings?.sessionPolicy;
  let review: ReturnType<typeof buildAgentSnapshot> | undefined;
  let error = "";
  try {
    review = buildAgentSnapshot(agent, "none", [], policy);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Export unavailable.";
  }
  async function encode(level: MemoryLevel, signal?: AbortSignal) {
    if (!reviewed || !review)
      throw new Error("Review portable configuration before sharing.");
    signal?.throwIfAborted();
    let memories: { slug: string; body: string }[] = [];
    if (level !== "none") {
      if (!sameCommunityAgents([agent], session.scope).length)
        throw new Error("Memory reads require the source agent's community.");
      const view = session.agentMemories.open(agent.pubkey);
      const dispose = () => view.dispose();
      signal?.addEventListener("abort", dispose, { once: true });
      try {
        await view.refresh();
        signal?.throwIfAborted();
        const result = view.snapshot();
        if (
          result.status !== "ready" ||
          !result.listing ||
          result.listing.partial
        )
          throw new Error(
            "Couldn’t load complete memories. Check your connection and try again.",
          );
        memories = result.listing.entries.map(({ slug, body }) => ({
          slug,
          body,
        }));
      } finally {
        signal?.removeEventListener("abort", dispose);
        view.dispose();
      }
    }
    const bytes = encodeAgentSnapshot(
      buildAgentSnapshot(agent, level, memories, policy),
      "png",
    );
    signal?.throwIfAborted();
    return {
      fileBytes: Array.from(bytes),
      fileName: `${agent.name.replace(/[^a-zA-Z0-9_-]+/g, "-")}.agent.png`,
    };
  }
  if (exporting)
    return (
      <AgentSnapshotExport
        agent={agent}
        defaultSessionPolicy={policy}
        session={session}
        destination={destination}
        onClose={close}
      />
    );
  return (
    <SnapshotShareDialog
      session={session}
      displayName={name}
      sourceId={agent.id}
      snapshotKind="agent"
      hasMemoryOptions={hasMemoryOptions}
      excludedPubkeys={[agent.pubkey]}
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
      encodeSnapshot={encode}
      copyLink={(snapshot, signal) =>
        copySnapshotLink({ session, snapshot, displayName: name, signal })
      }
      onExport={() => setExporting(true)}
      catalog={unusedCatalog}
      actionsDisabled={!reviewed || !review}
      beforeShare={
        <>
          <p>
            Portable configuration includes the agent name, instructions, model,
            provider, worker count and avatar URL when present. Review the
            actual values before sharing: free text can contain secrets that
            automated checks cannot detect.
          </p>
          <details>
            <summary>Review portable configuration</summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
              {JSON.stringify(review, null, 2)}
            </pre>
          </details>
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              disabled={!review}
              onChange={(event) => setReviewed(event.target.checked)}
            />{" "}
            I reviewed the portable configuration and understand it may contain
            private information.
          </label>
          {error && <p role="alert">{error}</p>}
        </>
      }
      catalogControls={
        <AgentShareSwitch
          session={session}
          agent={agent}
          name={name}
          defaultSessionPolicy={policy}
        />
      }
    />
  );
}

export function TeamDirectShare({
  session,
  control,
  kit,
  team,
  onClose,
}: {
  session: RelaySession;
  control: AgentControl;
  kit: ChannelKit;
  team: Team;
  onClose(): void;
}) {
  const [exporting, setExporting] = useState(false);
  const [catalogPending, setCatalogPending] = useState(false);
  const community = relayOrigin(
    session.scope.slice(0, -((session.viewer?.length ?? 0) + 1)),
  );
  async function encode(level: MemoryLevel, signal?: AbortSignal) {
    if (!control.previewTeam || !control.exportTeam)
      throw new Error("Team export is unavailable");
    const loaded = await kit.loadTeam(team);
    signal?.throwIfAborted();
    const portable = await control.previewTeam(JSON.stringify(loaded));
    signal?.throwIfAborted();
    const snapshot = await control.exportTeam(
      portable,
      team.agents,
      community,
      level,
    );
    signal?.throwIfAborted();
    const blob = encodeTeam(snapshot, "png");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    signal?.throwIfAborted();
    return {
      fileBytes: Array.from(bytes),
      fileName: `${team.name.replace(/[^a-zA-Z0-9_-]+/g, "-")}.team.png`,
    };
  }
  if (exporting)
    return (
      <TeamExportDialog
        team={team}
        control={control}
        kit={kit}
        community={community}
        close={onClose}
      />
    );
  return (
    <SnapshotShareDialog
      session={session}
      preventClose={catalogPending}
      displayName={team.name}
      sourceId={team.id}
      snapshotKind="team"
      hasMemoryOptions
      excludedPubkeys={team.agents}
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      encodeSnapshot={encode}
      copyLink={(snapshot, signal) =>
        copySnapshotLink({ session, snapshot, displayName: team.name, signal })
      }
      onExport={() => setExporting(true)}
      catalog={unusedCatalog}
      catalogControls={
        <CatalogShareSwitch
          onPendingChange={setCatalogPending}
          catalog={session.communityCatalog}
          kind={TEAM_CATALOG_KIND}
          d={team.id}
          name={team.name}
          description={teamShareDescription}
          content={() => buildTeamCatalogContent(session, control, kit, team)}
        />
      }
    />
  );
}
