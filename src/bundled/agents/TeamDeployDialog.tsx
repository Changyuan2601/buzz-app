import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { AgentControl } from "../../features/agents/control";
import type { Team } from "../../features/channel-templates/model";
import {
  deployTeam,
  teamDeployment,
  type TeamDeployment,
} from "../../features/agents/team-deployment";
import type { RelaySession } from "../../features/relay/session";
import { canAddMembers } from "../../features/channel-members/members";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";

export function TeamDeployDialog({
  team,
  kit,
  control,
  session,
  close,
}: {
  team: Team;
  kit: ChannelKit;
  control?: AgentControl | undefined;
  session: RelaySession;
  close(): void;
}) {
  const inventory = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channels = inventory.channels.filter((channel) =>
    canAddMembers(session, channel),
  );
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [attempt, setAttempt] = useState<TeamDeployment>();
  const [busy, setBusy] = useState(false);
  const cancellation = useRef<AbortController | null>(null);
  useEffect(() => () => cancellation.current?.abort(), []);
  function dismiss() {
    cancellation.current?.abort();
    close();
  }
  const [error, setError] = useState("");
  async function deploy() {
    if (busy) return;
    const abort = new AbortController();
    cancellation.current = abort;
    setBusy(true);
    setError("");
    try {
      const operation = attempt ?? teamDeployment(team, channelId);
      setAttempt(operation);
      const snapshot = team.portable
        ? await control?.previewTeam?.(JSON.stringify(await kit.loadTeam(team)))
        : undefined;
      if (team.portable && !snapshot)
        throw new Error("Team preview is unavailable");
      await deployTeam(control, session, operation, abort.signal, snapshot);
      if (!abort.signal.aborted) close();
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title="Deploy team to channel"
      preventClose={busy}
      description={
        <>
          Attach the saved agents of <strong>{team.name}</strong> to the
          selected channel.
        </>
      }
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      actions={
        <>
          <Button variant="outline" onClick={dismiss}>
            Cancel
          </Button>
          <Button disabled={busy || !channelId} onClick={() => void deploy()}>
            {busy
              ? "Deploying..."
              : `Deploy ${team.agents.length} ${team.agents.length === 1 ? "agent" : "agents"}`}
          </Button>
        </>
      }
    >
      <p className="text-label-sm">Agents ({team.agents.length})</p>
      <Select
        label="Channel"
        variant="field"
        value={channelId}
        disabled={busy || !!attempt}
        placeholder="No channels available"
        onValueChange={setChannelId}
        groups={[
          {
            label: "",
            options: channels.map((channel) => ({
              value: channel.id,
              label: channel.name,
            })),
          },
        ]}
      />
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-body-sm text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
