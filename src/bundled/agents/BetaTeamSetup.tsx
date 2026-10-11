import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AgentControl,
  AgentControlState,
  BetaTeamRestorePreview,
  ImportSource,
  PendingBetaTeam,
} from "../../features/agents/control";
import { oldBuzzLabel } from "../../features/agents/control";
import { runBetaTeamStep } from "../../features/agents/beta-team-import";
import { sameCommunityAgents } from "../../features/agents/choices";
import { sessionCommunity } from "../../features/agents/team-instructions";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Select } from "../../shared/design-system/ui/Select";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  UsersIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

const count = (n: number) => (n === 1 ? "1 agent" : `${n} agents`);

/** Picks one of several old Buzz texts for a team, away from the page. */
function ChooseInstructions({
  team,
  action,
  disabled,
  onChoose,
}: {
  team: PendingBetaTeam;
  action: string;
  disabled: boolean;
  onChoose: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="compact"
        variant="primary"
        disabled={disabled}
        aria-label={`Choose instructions for ${team.name}`}
        onClick={() => setOpen(true)}
      >
        Choose instructions…
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="wide"
        title={`Choose instructions for ${team.name}`}
        description="Members had different team instructions in old Buzz. The team keeps the ones you choose."
      >
        <div className="flex flex-col gap-4">
          {team.texts.map((text, index) => (
            <div key={text} className="flex flex-col items-start gap-2">
              <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-primary p-3 text-body-sm">
                {text}
              </pre>
              <Button
                size="compact"
                disabled={disabled}
                aria-label={`${action} with instructions ${index + 1}`}
                onClick={() => {
                  setOpen(false);
                  onChoose(text);
                }}
              >
                Use these instructions
              </Button>
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );
}

/** One team row: what it is, why it's here, and its one action. */
function TeamRow({
  row,
  team,
  names,
  note,
  stalled,
  label,
  action,
  disabled,
  onChoose,
}: {
  row: string;
  team: PendingBetaTeam;
  names: string;
  note?: string | undefined;
  stalled?: boolean;
  label: string;
  action: string;
  disabled: boolean;
  onChoose: (text: string) => void;
}) {
  const Icon = stalled ? WarningCircleIcon : UsersIcon;
  return (
    <div className="agent-inventory-row" data-settle={row}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary">
          <Icon size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="m-0 text-label">{team.name}</p>
          <p className="m-0 text-body-sm text-secondary">
            {stalled
              ? `Restored, but ${count(team.members.length)} still need to join it.`
              : `${count(team.members.length)}${names && ` · ${names}`}`}
          </p>
          {note && <p className="m-0 text-body-sm text-secondary">{note}</p>}
          {team.texts.length > 1 && (
            <p className="m-0 text-body-sm text-secondary">
              Members had different instructions in old Buzz.
            </p>
          )}
        </div>
      </div>
      <div className="agent-inventory-actions flex items-center gap-2">
        {team.texts.length > 1 ? (
          <ChooseInstructions
            team={team}
            action={action}
            disabled={disabled}
            onChoose={onChoose}
          />
        ) : (
          <Button
            size="compact"
            variant="primary"
            disabled={disabled}
            aria-label={action}
            onClick={() => onChoose(team.texts[0] ?? "")}
          >
            {label}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Finishes teams carried over from old Buzz in the open community, and
 * restores them for agents imported before teams were recorded. Needs the
 * community's ready team catalog; until then agents simply stay pending. */
export function BetaTeamSetup({
  control,
  state,
  session,
  viewer,
}: {
  control: AgentControl;
  state: AgentControlState;
  session: RelaySession;
  viewer: string;
}) {
  const kit = useSyncExternalStore(
    session.channelKit.subscribe,
    session.channelKit.snapshot,
  );
  useEffect(() => session.channelKit.ensure(), [session]);
  const community = sessionCommunity(session.scope, viewer);
  // Null until the first successful read: unknown is never "all set up".
  const [pending, setPending] = useState<PendingBetaTeam[] | null>(null);
  const [preview, setPreview] = useState<BetaTeamRestorePreview | null>(null);
  const [source, setSource] = useState<ImportSource>("installed");
  // Which operation runs; every control waits on any of them.
  const [busy, setBusy] = useState<"finding" | "setting" | null>(null);
  const working = busy !== null;
  const [problem, setProblem] = useState<string | null>(null);
  // The pending-team read fails apart from actions, and retries on its own.
  const [readProblem, setReadProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const find = useRef<HTMLButtonElement>(null);
  const [refind, setRefind] = useState(false);
  const section = useRef<HTMLElement>(null);
  // A finished choice removes its row, and a successful retry its button,
  // taking the focused control along. Holds the `data-settle` key whose
  // removal hands focus to the section, from the action until that element
  // goes, the action fails, or focus or a pointer moves elsewhere. A pending
  // and a preview row can share a team, so rows are keyed by kind and team.
  const settle = useRef<string | null>(null);
  const ready = kit.status === "ready" && state.status === "ready";
  // A refused restore needs a fresh preview. The control hides this section
  // until status is confirmed again, so wait for an enabled Find to exist.
  useEffect(() => {
    if (!refind || working || !ready || !find.current) return;
    find.current.focus();
    setRefind(false);
  }, [refind, working, ready]);
  useEffect(() => {
    // Clicking empty space moves no focus, so pointers cancel too. A chosen
    // text arms only on click, after its pointerdown, so dialogs don't cancel.
    const moved = (event: Event) => {
      const row = settle.current;
      if (row === null || !(event.target instanceof Element)) return;
      const at = event.target.closest<HTMLElement>("[data-settle]");
      if (at?.dataset.settle !== row) settle.current = null;
    };
    document.addEventListener("focusin", moved);
    document.addEventListener("pointerdown", moved);
    return () => {
      document.removeEventListener("focusin", moved);
      document.removeEventListener("pointerdown", moved);
    };
  }, []);
  useEffect(() => {
    const row = settle.current;
    // A hidden section (catalog reloading) proves nothing; wait for it.
    if (row === null || working || !section.current) return;
    const marks =
      section.current.querySelectorAll<HTMLElement>("[data-settle]");
    if ([...marks].some((el) => el.dataset.settle === row)) return;
    settle.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) section.current.focus();
  });
  const agents = sameCommunityAgents(state.data?.agents ?? [], session.scope);
  const unrecorded = agents.filter((agent) => agent.betaTeam === null);
  // Re-read whenever an agent's team status or revision changes.
  const statusKey = agents
    .map((a) => `${a.id}:${a.revision}:${a.betaTeam?.status ?? ""}`)
    .join(",");
  useEffect(() => {
    if (!ready || !control.betaTeams) return;
    let live = true;
    void statusKey;
    void attempt;
    control.betaTeams(community).then(
      (teams) => {
        if (!live) return;
        setPending(teams);
        setReadProblem(null);
      },
      (reason) => {
        if (!live) return;
        if (settle.current === "retry") settle.current = null;
        setPending(null);
        setReadProblem(message(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [control, community, ready, statusKey, attempt]);
  if (!ready || !control.finishBetaTeam) return null;
  const act = async (
    kind: "finding" | "setting",
    task: () => Promise<string | undefined>,
  ) => {
    setBusy(kind);
    setProblem(null);
    try {
      setProblem((await task()) ?? null);
    } catch (reason) {
      setProblem(message(reason));
    } finally {
      setBusy(null);
    }
  };
  // Arms the focus handoff for one choice; failure or refusal disarms it.
  const settled = (row: string, task: () => Promise<string | undefined>) =>
    act("setting", async () => {
      settle.current = row;
      try {
        const failed = await task();
        if (failed !== undefined) settle.current = null;
        return failed;
      } catch (reason) {
        settle.current = null;
        throw reason;
      }
    });
  const finish = (team: PendingBetaTeam, text: string) =>
    settled(`pending:${team.teamId}`, async () => {
      const { failed } = await runBetaTeamStep(
        session.channelKit,
        control,
        community,
        team,
        { text },
      );
      return failed[0];
    });
  const restore = (
    preview: BetaTeamRestorePreview,
    group: PendingBetaTeam,
    text: string,
  ) =>
    settled(`preview:${group.teamId}`, async () => {
      if (!control.restoreBetaTeam || !control.betaTeams)
        throw new Error("Teams from old Buzz are unavailable.");
      await control
        .restoreBetaTeam(community, preview.token, group.teamId, text)
        .catch((reason) => {
          setRefind(true);
          throw reason;
        });
      setPreview(null);
      const team = (await control.betaTeams(community)).find(
        (t) => t.teamId === group.teamId,
      );
      if (!team) return undefined;
      const { failed } = await runBetaTeamStep(
        session.channelKit,
        control,
        community,
        team,
        { text },
      );
      return failed[0];
    });
  const canRestore = !!control.restoreBetaTeams && !!control.restoreBetaTeam;
  // Only an inventory naming exactly one library hides the other; older
  // hosts omit it, and an unreadable library can keep stale rows.
  const sources = ["installed", "development"] as const;
  const listed = sources.filter((value) =>
    state.data?.parked?.some((row) => row.sources.includes(value)),
  );
  const libraries = listed.length === 1 ? listed : sources;
  const library =
    libraries.length === 1 ? (libraries[0] as ImportSource) : source;
  const names = (team: PendingBetaTeam) =>
    team.members
      .map((member) => agents.find((agent) => agent.id === member.id)?.name)
      .filter(Boolean)
      .join(", ");
  const findTeams = () =>
    act("finding", async () => {
      if (!control.restoreBetaTeams)
        throw new Error("Teams from old Buzz are unavailable.");
      // Finding again can expire the shown token, even on failure.
      setPreview(null);
      const next = await control.restoreBetaTeams(
        library,
        unrecorded.map((agent) => agent.id),
      );
      setPreview(next);
      return undefined;
    });
  const known = pending ?? [];
  const done = pending !== null && !pending.length && !unrecorded.length;
  const body = () => {
    if (busy === "finding") return "Reading teams from old Buzz…";
    if (done) return null;
    if (preview && !preview.groups.length)
      return `${oldBuzzLabel(library)} has no teams for your imported agents.${
        libraries.length > 1
          ? " If your agents also lived in the other library, choose it above and find again."
          : ""
      }`;
    if (!preview && !known.length)
      return "Find the teams your imported agents belonged to in old Buzz. Nothing changes until you restore a team.";
    return null;
  };
  const line = body();
  const rows = [
    ...known.map((team) => (
      <TeamRow
        key={`pending:${team.teamId}`}
        row={`pending:${team.teamId}`}
        team={team}
        names={names(team)}
        stalled
        label="Finish setup"
        action={`Finish team setup for ${team.name}`}
        disabled={working}
        onChoose={(text) => void finish(team, text)}
      />
    )),
    ...(preview?.groups ?? []).map((group) => (
      <TeamRow
        key={`preview:${group.teamId}`}
        row={`preview:${group.teamId}`}
        team={group}
        names={names(group)}
        note={
          group.inferred
            ? "Old Buzz no longer lists this team. It was rebuilt from the agents' saved copies."
            : undefined
        }
        label="Restore team"
        action={`Restore team ${group.name}`}
        disabled={working}
        onChoose={(text) => preview && void restore(preview, group, text)}
      />
    )),
  ];
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby="old-buzz-teams"
      className="flex flex-col gap-3 text-body outline-none"
    >
      <InlineHeader
        id="old-buzz-teams"
        title="From old Buzz"
        subtitle="Restore teams for agents you already imported. Old Buzz isn't changed."
        actions={
          canRestore && (
            <>
              {libraries.length > 1 && (
                <Select
                  label="Old Buzz library"
                  variant="compact"
                  align="end"
                  disabled={working}
                  value={source}
                  groups={[
                    {
                      label: "",
                      options: libraries.map((value) => ({
                        value,
                        label: oldBuzzLabel(value),
                      })),
                    },
                  ]}
                  onValueChange={(value) => {
                    // A preview belongs to the library it was found in.
                    setPreview(null);
                    setSource(value as ImportSource);
                  }}
                />
              )}
              <Button
                ref={find}
                variant="ghost"
                size="sm"
                loading={busy === "finding"}
                disabled={working || !unrecorded.length}
                onClick={() => void findTeams()}
              >
                <ArrowsClockwiseIcon size={16} />{" "}
                {preview ? "Find teams again" : "Find teams"}
              </Button>
            </>
          )
        }
      />
      {readProblem && (
        <div className="flex flex-wrap items-center gap-2" data-settle="retry">
          <p role="alert" className="m-0 text-body-sm text-danger">
            {readProblem}
          </p>
          <Button
            variant="ghost"
            size="compact"
            disabled={working}
            onClick={() => {
              settle.current = "retry";
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {problem && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {problem}
        </p>
      )}
      {line && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {line}
        </p>
      )}
      {!!rows.length && (
        <div className="overflow-hidden rounded-xl border border-primary">
          {rows}
        </div>
      )}
      {done && (
        <p
          role="status"
          className="m-0 flex items-center gap-2 text-body-sm text-secondary"
        >
          <CheckCircleIcon size={16} aria-hidden="true" />
          All teams from old Buzz are set up.
        </p>
      )}
    </section>
  );
}
