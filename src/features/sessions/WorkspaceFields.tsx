import { useRef, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Switch } from "../../shared/design-system/ui/Switch";
import type { Workspace } from "./workspace";
import styles from "./WorkspaceSettings.module.css";

export function WorkspaceFields({
  value,
  onChange,
}: {
  value: Workspace;
  onChange(value: Workspace): void;
}) {
  const [picking, setPicking] = useState<number>();
  const [pickerError, setPickerError] = useState("");
  const current = useRef({ value, onChange });
  current.current = { value, onChange };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const browse = async (index: number) => {
    setPicking(index);
    setPickerError("");
    try {
      const path = await invoke<string | null>("workspace_pick_folder");
      if (!alive.current || !path || !current.current.value.worktree) return;
      const latest = current.current.value;
      const folders = latest.folders.length ? [...latest.folders] : [""];
      if (index >= folders.length) return;
      folders[index] = path;
      current.current.onChange({ ...latest, folders });
    } catch (reason) {
      if (alive.current)
        setPickerError(
          reason instanceof Error ? reason.message : String(reason),
        );
    } finally {
      if (alive.current) setPicking(undefined);
    }
  };
  const worktree = value.worktree;
  return (
    <div className={styles.fields}>
      <div className={styles.projectFolders}>
        <div className={styles.workspaceLabel}>Project folders</div>
        <div>
          <Switch
            label="Work in a new worktree"
            checked={!!value.worktree}
            onCheckedChange={(checked) =>
              onChange({
                ...value,
                worktree: checked
                  ? { location: "~/.buzz/worktrees", baseBranch: "main" }
                  : undefined,
              })
            }
          />
        </div>
      </div>
      {!value.worktree && (
        <Field label="Project folders" labelVisibility="hidden">
          <div>
            <Textarea
              rows={2}
              value={value.folders.join("\n")}
              placeholder="~/Development/my-project"
              onChange={(event) =>
                onChange({ ...value, folders: event.target.value.split("\n") })
              }
            />
          </div>
        </Field>
      )}
      {value.worktree && (
        <div className={styles.fields}>
          {(value.folders.length ? value.folders : [""]).map(
            (folder, index, folders) => (
              <Field
                // biome-ignore lint/suspicious/noArrayIndexKey: Fixed repository slots are edited in place, never reordered here.
                key={index}
                label={
                  folders.length === 1
                    ? "Source repository"
                    : `Source repository ${index + 1}`
                }
              >
                <div className={styles.repositoryInput}>
                  <Input
                    value={folder}
                    placeholder="~/Development/my-project"
                    onChange={(event) => {
                      const next = [...folders];
                      next[index] = event.target.value;
                      onChange({ ...value, folders: next });
                    }}
                  />
                  {isTauri() && (
                    <Button
                      shape="control"
                      disabled={picking !== undefined}
                      aria-label={`Browse source repository${folders.length > 1 ? ` ${index + 1}` : ""}`}
                      onClick={() => void browse(index)}
                    >
                      Browse…
                    </Button>
                  )}
                </div>
              </Field>
            ),
          )}
          {pickerError && <p role="alert">{pickerError}</p>}
          <div className={styles.worktree}>
            <Field label="Worktree location">
              <Input
                value={value.worktree.location}
                onChange={(event) =>
                  worktree &&
                  onChange({
                    ...value,
                    worktree: {
                      ...worktree,
                      location: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="Base branch">
              <Input
                value={value.worktree.baseBranch}
                onChange={(event) =>
                  worktree &&
                  onChange({
                    ...value,
                    worktree: {
                      ...worktree,
                      baseBranch: event.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>
        </div>
      )}
      <Field label="Canvas">
        <Textarea
          rows={5}
          value={value.canvas}
          onChange={(event) =>
            onChange({ ...value, canvas: event.target.value })
          }
          placeholder="Instructions and context for agents working in this session."
        />
      </Field>
    </div>
  );
}
