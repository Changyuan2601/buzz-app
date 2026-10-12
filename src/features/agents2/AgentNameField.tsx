import { useState } from "react";
import { useDraftState } from "../drafts/react";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Button } from "../../shared/design-system/ui/Button";

/** Explicit local draft. Blur never saves; failed saves retain the text. */
export function AgentNameField({
  name,
  onSave,
}: {
  name: string;
  onSave(name: string): Promise<void>;
}) {
  const [draft, setDraft] = useState(name);
  const [baseline, setBaseline] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (name !== baseline && draft === baseline) {
    setBaseline(name);
    setDraft(name);
  }
  const dirty = draft !== name;
  const discard = () => {
    setDraft(name);
    setBaseline(name);
    setError("");
  };
  useDraftState("agent name", { dirty, saving, revision: draft }, discard);
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving || !dirty) return;
        if (!draft.trim()) {
          setError("Name the agent.");
          return;
        }
        setSaving(true);
        setError("");
        void onSave(draft.trim())
          .then(
            () => {
              setBaseline(draft.trim());
              setDraft(draft.trim());
            },
            (reason) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not save the name.",
              ),
          )
          .finally(() => setSaving(false));
      }}
    >
      <Field label="Name" error={error || undefined}>
        <Input value={draft} disabled={saving} onValueChange={setDraft} />
      </Field>
      {dirty && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={saving} onClick={discard}>
            Discard
          </Button>
          <Button type="submit" variant="prominent" loading={saving}>
            Save name
          </Button>
        </div>
      )}
    </form>
  );
}
