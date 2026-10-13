// The app's Instructions tab: one field for what the agent is told, saved as a
// new version (NIP-AP kind 44300). A running session keeps the text it started
// with; the next session gets the saved one.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentInstructions } from "./AgentInstructions";
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
  // Until the user edits, the field follows the current version.
  useEffect(() => {
    if (draft === undefined) setBase(view?.head);
  }, [draft, view?.head]);
  if (!view) return null;
  const value = draft ?? current ?? "";
  const blocked = resolved && "blocked" in resolved ? resolved.blocked : "";
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await agents.saveInstructions?.(agent.pubkey, value, base);
      setDraft(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const status = view.save;
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
      {status && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {STATUS[status.state]}
          {"reason" in status && status.reason ? ` ${status.reason}` : ""}
        </p>
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
          disabled={draft === undefined || draft === current}
          focusableWhenDisabled
        >
          Save
        </Button>
      </div>
    </form>
  );
}
