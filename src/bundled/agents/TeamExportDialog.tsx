import { useEffect, useRef, useState } from "react";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import type { AgentControl } from "../../features/agents/control";
import type { Team } from "../../features/channel-templates/model";
import type { ChannelKit } from "../../features/channel-templates/capability";
import { encodeTeam } from "../../features/agents/team-encoding";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";

export function TeamExportDialog({
  team,
  control,
  kit,
  community,
  close,
}: {
  team: Team;
  kit: ChannelKit;
  community: string;
  control: AgentControl;
  close(): void;
}) {
  const [format, setFormat] = useState<"png" | "json">("png");
  const [memory, setMemory] = useState<"none" | "core" | "everything">("none");
  const [confirmed, setConfirmed] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!control.exportTeam || busy || (memory !== "none" && !confirmed))
      return;
    setBusy(true);
    setError("");
    try {
      const loaded = await kit.loadTeam(team);
      if (!control.previewTeam) throw new Error("Team preview is unavailable");
      if (!active.current) return;
      const portable = await control.previewTeam(JSON.stringify(loaded));
      if (!active.current) return;
      const snapshot = await control.exportTeam(
        portable,
        team.agents,
        community,
        memory,
      );
      if (!active.current) return;
      const url = URL.createObjectURL(encodeTeam(snapshot, format));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${team.name.replace(/[^a-z0-9_-]/gi, "-")}.team.${format}`;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      close();
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={`Export ${team.name}`}
      preventClose={busy}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actions={
        <>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || (memory !== "none" && !confirmed)}
            onClick={() => void save()}
          >
            Export
          </Button>
        </>
      }
    >
      <Select
        label="Memories"
        value={memory}
        disabled={busy}
        variant="field"
        onValueChange={(value) => {
          if (value === "none" || value === "core" || value === "everything") {
            setMemory(value);
            setConfirmed(false);
          }
        }}
        groups={[
          {
            label: "",
            options: [
              { value: "none", label: "Team only" },
              { value: "core", label: "Team + core memory" },
              { value: "everything", label: "Team + all memories" },
            ],
          },
        ]}
      />
      {memory !== "none" && (
        <>
          <p className="text-body-sm text-secondary">
            Memory is stored as plaintext in the snapshot. Only share it with
            people you trust.
          </p>
          <Checkbox
            checked={confirmed}
            disabled={busy}
            onCheckedChange={(value) => setConfirmed(value === true)}
            label="I confirm that I want to include memory in this snapshot."
          />
        </>
      )}
      <Select
        label="File format"
        value={format}
        disabled={busy}
        variant="field"
        onValueChange={(value) => {
          if (value === "png" || value === "json") setFormat(value);
        }}
        groups={[
          {
            label: "",
            options: [
              { value: "json", label: "JSON" },
              { value: "png", label: "PNG" },
            ],
          },
        ]}
      />
      {error && (
        <p role="alert" className="text-body-sm text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
