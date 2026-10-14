// The app's Instructions tab: one field for what the agent is told, saved as a
// new version (NIP-AP kind 44300). A running session keeps the text it started
// with; the next session gets the saved one.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentInstructions } from "./AgentInstructions";
import { ConflictError } from "./instructions";
import type { Agent, AgentInstructionsView, Agents } from "./service";

const STATUS: Record<
  NonNullable<AgentInstructionsView["save"]>["state"],
  string
> = {
  saving: "Saving…",
  stored: "Saved. New sessions use it.",
  uncertain: "Couldn't confirm this change saved.",
  rejected: "The relay refused this change.",
};

export function InstructionsPanel({
  agents,
  agent,
}: {
  agents: Agents;
  agent: Agent;
}) {
  // `instructions()` builds a fresh view each call, so subscribe to a stable
  // key and derive the view from it.
  const key = useSyncExternalStore(
    (listener) => agents.subscribe(listener),
    () => JSON.stringify(agents.instructions?.(agent.pubkey) ?? null),
  );
  const view = useMemo(
    () => (JSON.parse(key) as AgentInstructionsView | null) ?? undefined,
    [key],
  );
  const resolved = view?.resolved;
  const current = resolved && "text" in resolved ? resolved.text : undefined;
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [base, setBase] = useState(view?.head);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ head: string | undefined }>();
  // Until the user edits, the field follows the current version.
  useEffect(() => {
    if (draft === undefined) setBase(view?.head);
  }, [draft, view?.head]);
  if (!view) return null;
  // An unconfirmed save keeps its text in the field until its version lands.
  const value = draft ?? view.submitted ?? current ?? "";
  const blocked = resolved && "blocked" in resolved ? resolved.blocked : "";
  const status = view.save;
  // A refused save, or one unconfirmed after the resend window, is replaced
  // only by an explicit new save (§2.5).
  const again =
    status?.state === "rejected" ||
    (status?.state === "uncertain" && status.expired);
  const save = async (over = base) => {
    setSaving(true);
    setError("");
    setConflict(undefined);
    try {
      await agents.saveInstructions?.(agent.pubkey, value, over);
      setDraft(undefined);
    } catch (reason) {
      if (reason instanceof ConflictError) setConflict({ head: reason.head });
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <AgentInstructions
        value={value}
        disabled={saving || (!!blocked && draft === undefined)}
        description="Saved as a new version. Running sessions keep what they started with."
        onChange={setDraft}
      />
      {blocked && draft === undefined && (
        <p className="m-0 text-body-sm text-secondary">{blocked}</p>
      )}
      {view.localOnly && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          History isn't available yet on this community. Saves stay on this
          device until it is.
        </p>
      )}
      {status && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {STATUS[status.state]}
          {"reason" in status && status.reason ? ` ${status.reason}` : ""}
        </p>
      )}
      {view.draft !== undefined && draft === undefined && (
        <div role="status" className="grid gap-2">
          <p className="m-0 text-body-sm text-secondary">
            Unsaved local edit from before history was enabled.
          </p>
          <div className="flex gap-2">
            <Button type="button" onClick={() => setDraft(view.draft)}>
              Edit it
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => agents.discardInstructionsDraft?.(agent.pubkey)}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
      {conflict && (
        <div role="alert" className="grid gap-2">
          <p className="m-0 text-body-sm">
            Changed on another device. Reapply saves your text over the newer
            version.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => {
                setBase(conflict.head);
                void save(conflict.head);
              }}
            >
              Reapply
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setConflict(undefined);
                setDraft(undefined);
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
      <div>
        <Button
          type="submit"
          variant="prominent"
          loading={saving}
          disabled={!again && (draft === undefined || draft === current)}
          focusableWhenDisabled
        >
          {again ? "Save again" : "Save"}
        </Button>
      </div>
    </form>
  );
}
