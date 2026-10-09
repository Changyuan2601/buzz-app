import { useState } from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { AgentControl } from "../../features/agents/control";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import { importTeamSnapshot } from "../../features/agents/team-import";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";

export function TeamImportDialog({
  snapshot,
  control,
  destination,
  kit,
  owner,
  close,
}: {
  snapshot: TeamSnapshot;
  control: AgentControl;
  destination: string;
  kit: ChannelKit;
  owner: string;
  close(): void;
}) {
  const [previewKeys] = useState(() =>
    snapshot.members.map(() => crypto.randomUUID()),
  );
  const [restore, setRestore] = useState(false);
  const [keep, setKeep] = useState(false);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    if (busy) return;
    setStarted(true);
    setBusy(true);
    setError("");
    try {
      const result = await importTeamSnapshot(control, kit, snapshot, {
        destination,
        owner,
        keepAllowlist: keep,
        restoreMemory: restore,
      });
      const failures = result.memories.filter((member) => member.errors.length);
      if (failures.length)
        throw new Error(
          failures
            .map(
              (member) =>
                `${member.pubkey}: ${member.written}/${member.total} memories restored. ${member.errors.join("; ")}`,
            )
            .join("\n"),
        );
      setDone(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={done ? "Team imported" : "Import team snapshot"}
      preventClose={busy}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actions={
        done ? (
          <Button onClick={close}>Close</Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void confirm()}>
              Import
            </Button>
          </>
        )
      }
    >
      <p className="text-label-sm">{snapshot.team.name}</p>
      {snapshot.team.description && (
        <p className="text-body-sm text-secondary">
          {snapshot.team.description}
        </p>
      )}
      {snapshot.team.instructions && (
        <p className="whitespace-pre-wrap text-body-sm text-secondary">
          {snapshot.team.instructions}
        </p>
      )}
      <p className="text-body-sm text-secondary">
        A new team will be created with fresh keypairs for all members. The
        imported team is independent of the source — identity never travels.
      </p>
      <p className="text-label-sm">Members ({snapshot.members.length})</p>
      {snapshot.members.map((member, index) => (
        <div key={previewKeys[index]}>
          <p className="text-label-sm">{member.profile.displayName}</p>
          {member.definition.systemPrompt && (
            <p className="whitespace-pre-wrap text-body-sm text-secondary">
              {member.definition.systemPrompt}
            </p>
          )}
        </div>
      ))}
      {snapshot.members.some((member) => member.memory.entries?.length) && (
        <Checkbox
          checked={restore}
          disabled={started}
          onCheckedChange={(checked) => setRestore(checked === true)}
          label="Restore member memories from this snapshot"
        />
      )}
      {snapshot.members.some(
        (member) => member.definition.respondToAllowlist?.length,
      ) && (
        <Select
          label="Respond-to allowlist"
          variant="field"
          value={keep ? "keep" : "clear"}
          disabled={started}
          onValueChange={(choice) => setKeep(choice === "keep")}
          description="This snapshot includes source-environment pubkey allowlists for one or more members. Those identities are not meaningful on your relay."
          groups={[
            {
              label: "",
              options: [
                {
                  value: "clear",
                  label: "Clear — start with empty allowlists (safer)",
                },
                {
                  value: "keep",
                  label: "Keep — copy source allowlists to new members",
                },
              ],
            },
          ]}
        />
      )}
      {busy && (
        <p role="status" className="text-body-sm text-secondary">
          Creating team…
        </p>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
