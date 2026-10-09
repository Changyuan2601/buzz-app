import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { KitEntry, Lineup, Template } from "../channel-templates/model";
import {
  emptyLineup,
  parseKitRecord,
  parseLineup,
} from "../channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Field } from "../../shared/design-system/ui/Field";
import { readView, writeView } from "../../shared/view-state";
import {
  emptyWorkspace,
  readWorkspace,
  sectionTemplateId,
  sectionDefault,
  workspaceCanvas,
  type Workspace,
} from "./workspace";
import { WorkspaceFields } from "./WorkspaceFields";
import styles from "./WorkspaceSettings.module.css";

type Target =
  | { kind: "section"; id: string; name: string }
  | { kind: "session"; id: string; name: string };
export function WorkspaceSettings({
  session,
  scope,
  target,
  close,
}: {
  session: RelaySession;
  scope: string;
  target: Target;
  close(): void;
}) {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [raw, setRaw] = useState<string>();
  const [base, setBase] = useState<string>();
  const [recipeId, setRecipeId] = useState("");
  const [lineup, setLineup] = useState<Lineup>(emptyLineup);
  const [entries, setEntries] = useState<readonly KitEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloadConfirmed, setReloadConfirmed] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const alive = useRef(true);
  const inFlight = useRef(false);
  const key = `sessions:workspace-draft:${target.kind}:${target.id}`;
  const adopt = (canvas: string) => {
    try {
      setWorkspace(readWorkspace(canvas));
      setRaw(undefined);
    } catch {
      setRaw(canvas);
    }
  };
  const load = async (replace = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      let content = "",
        revision: string | undefined;
      if (target.kind === "section") {
        await session.channelKit.refresh();
        if (!alive.current) return;
        const kit = session.channelKit.snapshot();
        if (kit.status !== "ready")
          throw new Error(kit.error ?? "Section defaults are unavailable.");
        const id = await sectionTemplateId(target.id);
        if (!alive.current) return;
        // Tombstones still own the revision even though they supply no defaults.
        const entry = kit.entries.find(
          (entry) =>
            entry.record.value.type === "template" &&
            entry.record.value.id === id,
        );
        const template = sectionDefault(kit.entries, target.id, id);
        setRecipeId(id);
        setEntries(kit.entries);
        setLineup(template ?? emptyLineup());
        content = template?.canvas ?? "";
        revision = entry?.eventId;
      } else {
        const head = await session.canvas.read(target.id);
        if (!alive.current) return;
        content = head?.content ?? "";
        revision = head?.id;
      }
      const saved = replace ? null : readView<unknown>(scope, key, null);
      if (
        saved &&
        typeof saved === "object" &&
        "canvas" in saved &&
        typeof saved.canvas === "string" &&
        "base" in saved &&
        (saved.base === null || typeof saved.base === "string")
      ) {
        if (target.kind === "section" && "lineup" in saved)
          setLineup(parseLineup(saved.lineup));
        adopt(saved.canvas);
        setBase(saved.base ?? undefined);
        if ((saved.base ?? undefined) !== revision)
          setError(
            "Saved settings changed while this draft was open. Your draft is kept; copy it before reloading.",
          );
      } else {
        adopt(content);
        setBase(revision);
      }
      setLoaded(true);
      setReloadConfirmed(false);
      if (replace) writeView(scope, key, null);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  // The dialog is keyed by destination; live reads must not rebase a draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load runs once for this keyed dialog.
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  const save = async () => {
    if (!alive.current || inFlight.current || !loaded) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const canvas = raw ?? workspaceCanvas(workspace);
      if (!writeView(scope, key, { canvas, base: base ?? null, lineup }))
        throw new Error(
          "Your draft couldn’t be saved on this device. No changes were sent.",
        );
      if (target.kind === "section") {
        const template: Template = {
          ...lineup,
          canvas,
          type: "template",
          id: recipeId,
          name: `${target.name.slice(0, 100)} sessions`,
          description:
            "Starting workspace and Canvas for new sessions in this section.",
        };
        // Validate the complete encrypted recipe budget before publication.
        parseKitRecord(
          { version: 1, community: "", deleted: false, value: template },
          "",
        );
        await session.channelKit.save(template, base);
      } else await session.canvas.save(target.id, canvas, base);
      writeView(scope, key, null);
      if (alive.current) close();
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const templates = entries.flatMap((entry) =>
    !entry.record.deleted &&
    entry.record.value.type === "template" &&
    !entry.record.value.id.startsWith("session-section-")
      ? [entry.record.value]
      : [],
  );
  return (
    <Dialog
      open
      height="stable"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      dismissOnOutsideClick
      title="Session settings"
      actions={
        <>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!loaded}
            variant="prominent"
            onClick={() => void save()}
          >
            Save {target.kind === "section" ? "defaults" : "changes"}
          </Button>
        </>
      }
    >
      <div className={styles.fields} inert={busy}>
        {loaded && (
          <>
            {target.kind === "section" && templates.length > 0 && (
              <Select
                label="Start from a template"
                variant="field"
                value={selectedTemplate}
                groups={[
                  {
                    label: "",
                    options: [
                      { value: "", label: "Custom settings" },
                      ...templates.map((template) => ({
                        value: template.id,
                        label: template.name,
                      })),
                    ],
                  },
                ]}
                onValueChange={(id) => {
                  const template = templates.find(
                    (template) => template.id === id,
                  );
                  if (template) {
                    setLineup(template);
                    adopt(template.canvas);
                  }
                  if (!id) setLineup(emptyLineup());
                  setSelectedTemplate(id);
                }}
              />
            )}
            {raw !== undefined ? (
              <Field
                label="Full Canvas"
                description="This Canvas has custom workspace instructions. Edit it directly to preserve them."
              >
                <Textarea
                  rows={12}
                  value={raw}
                  onChange={(event) => setRaw(event.target.value)}
                />
              </Field>
            ) : (
              <WorkspaceFields value={workspace} onChange={setWorkspace} />
            )}
            {target.kind === "section" &&
              (lineup.agents.length > 0 || lineup.teamIds.length > 0) && (
                <p className="text-secondary">
                  The selected template’s agents and teams are also included in
                  new sessions.
                </p>
              )}
            {error && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (reloadConfirmed) void load(true);
                  else setReloadConfirmed(true);
                }}
              >
                {reloadConfirmed
                  ? "Discard draft and reload saved settings"
                  : "Review saved settings"}
              </Button>
            )}
          </>
        )}
        {!loaded && !busy && (
          <Button onClick={() => void load()}>Retry settings</Button>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      {busy && !loaded && <p role="status">Loading settings…</p>}
    </Dialog>
  );
}
