import { useId, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import { emptyLineup } from "../channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  emptyWorkspace,
  sectionTemplate,
  sectionTemplateId,
  workspaceCanvas,
  type Workspace,
} from "./workspace";
import { WorkspaceFields } from "./WorkspaceFields";
import styles from "./WorkspaceSettings.module.css";

/**
 * Creates an empty Me project with the same starting folders and Canvas that
 * Project settings edits. Retrying reuses the same project ID, so a failed
 * defaults save never creates a second project.
 */
export function NewProject({
  session,
  create,
  close,
  onCreated,
}: {
  session: RelaySession;
  create(section: { id: string; name: string }): Promise<unknown>;
  close(): void;
  onCreated(id: string): void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      // Validate defaults before anything is published.
      const canvas = workspaceCanvas(workspace);
      await create({ id, name: trimmed });
      if (canvas)
        await session.channelKit.save(
          sectionTemplate(await sectionTemplateId(id, true), trimmed, true, {
            ...emptyLineup(),
            canvas,
          }),
          undefined,
        );
      onCreated(id);
      close();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Project could not be created. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      title="New project"
      description="The chats you start in this project begin with its folders and instructions."
      initialFocus={input}
      actions={
        <>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            form={form}
            type="submit"
            variant="prominent"
            loading={busy}
            disabled={!name.trim()}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        id={form}
        className={styles.fields}
        inert={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <Input
            ref={input}
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <WorkspaceFields value={workspace} onChange={setWorkspace} />
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
