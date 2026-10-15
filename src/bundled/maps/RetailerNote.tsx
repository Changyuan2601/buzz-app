import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  loadNote,
  saveNote,
  NoteConflict,
  type RetailerNote as Note,
} from "./notes";

export function RetailerNote({
  scope,
  channel,
  location,
  onSaving,
}: {
  scope: string;
  channel: string;
  location: string;
  onSaving(value: boolean): void;
}) {
  const [saved, setSaved] = useState<Note>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [compare, setCompare] = useState(false);
  const [status, setStatus] = useState<string>();
  const [reload, setReload] = useState(0);
  const initialized = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload explicitly requests the latest saved version without discarding the draft.
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(undefined);
    void loadNote(scope, channel, location, abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        if (!initialized.current) setDraft(next.text);
        initialized.current = true;
        setSaved(next);
        setConflict(false);
        setLoading(false);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setError("Saved note couldn’t load. Retry before saving changes.");
        setLoading(false);
      });
    return () => abort.abort();
  }, [scope, channel, location, reload]);
  async function save() {
    if (!saved || saving || loading || conflict) return;
    setSaving(true);
    onSaving(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const next = await saveNote(scope, channel, location, {
        text: draft,
        revision: saved.revision,
      });
      setSaved(next);
      setCompare(false);
      setStatus(draft ? "Note saved." : "Note cleared.");
    } catch (cause) {
      setConflict(cause instanceof NoteConflict);
      setError(
        cause instanceof Error
          ? cause.message
          : "Note couldn’t save. Your draft is still here.",
      );
    } finally {
      setSaving(false);
      onSaving(false);
    }
  }
  return (
    <section className="mt-4" aria-label="Retailer note">
      <Field
        label="Note"
        description="Personal note saved for you in this channel."
        error={error}
      >
        <Textarea
          value={draft}
          rows={3}
          disabled={loading || saving || !saved}
          placeholder="Add a note…"
          onChange={(event) => {
            setDraft(event.target.value);
            setStatus(undefined);
          }}
        />
      </Field>
      {compare && saved && (
        <div className="mt-2 text-body-sm text-secondary">
          <p>Latest saved note (your draft is unchanged):</p>
          <p className="max-h-32 overflow-auto whitespace-pre-wrap">
            {saved.text || "No note"}
          </p>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            loading || saving || conflict || !saved || draft === saved.text
          }
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save note"}
        </Button>
        {error && (
          <Button
            size="sm"
            disabled={loading || saving}
            onClick={() => {
              setCompare(conflict);
              setReload((value) => value + 1);
            }}
          >
            {conflict ? "Load latest saved note" : "Retry loading note"}
          </Button>
        )}
        <span role="status" className="text-body-sm text-secondary">
          {loading ? "Loading note…" : status}
        </span>
      </div>
    </section>
  );
}
