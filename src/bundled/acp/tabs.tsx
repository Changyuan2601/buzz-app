// An ACP agent's settings: a preset or a typed command, its args and env, and
// the screen where the owner confirms the exact launch before it can run.
import { useEffect, useRef, useState } from "react";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import type { AgentViewProps } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  approve,
  approved,
  type Config,
  problems,
  config as readConfig,
  shownValue,
  withPreset,
} from "./config";
import { READY } from "./harness";
import { CUSTOM, PRESETS } from "./presets";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const PRESET_GROUPS = [
  {
    label: "",
    options: [
      ...PRESETS.map(({ id, title, verified }) => ({
        value: id,
        label: verified ? title : `${title} (unverified)`,
      })),
      { value: CUSTOM, label: "Custom command" },
    ],
  },
];

type Row = Readonly<{ name: string; value: string }>;
const rowsOf = (env: Config["env"]): Row[] =>
  Object.entries(env).map(([name, value]) => ({ name, value }));
const replaced = (rows: readonly Row[], at: number, row: Row) =>
  rows.map((old, index) => (index === at ? row : old));
/** What an env row is called to a screen reader: its name, or its place. */
const rowLabel = ({ name }: Row, index: number) =>
  name.trim() || `variable ${index + 1}`;
const envOf = (rows: readonly Row[]) =>
  Object.fromEntries(
    rows.filter(({ name }) => name.trim()).map((r) => [r.name.trim(), r.value]),
  );

/** Whether the stored config's approval covers its launch as saved. */
function useApproved(value: Config) {
  const [current, setCurrent] = useState(false);
  const key = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` follows `key`.
  useEffect(() => {
    let live = true;
    approved(value).then((ok) => live && setCurrent(ok));
    return () => {
      live = false;
    };
  }, [key]);
  return current;
}

/** The exact launch, as the owner confirms it: argv, workspace, env names, and
 * the value of `PATH` only. */
export function Confirmation({ value }: Readonly<{ value: Config }>) {
  const names = Object.keys(value.env).sort();
  return (
    <dl className="grid gap-2">
      <dt>Runs</dt>
      <dd>
        <code>{JSON.stringify([value.command, ...value.args])}</code>
      </dd>
      <dt>In</dt>
      <dd>
        <code>{value.workspace}</code>
      </dd>
      <dt>Environment</dt>
      <dd>
        {names.length === 0
          ? "No extra variables."
          : names.map((name) => {
              const shown = shownValue(name, value.env[name] ?? "");
              return (
                <div key={name}>
                  <code>{shown === undefined ? name : `${name}=${shown}`}</code>
                </div>
              );
            })}
      </dd>
    </dl>
  );
}

export function createTabs({
  check,
}: Readonly<{
  /** Starts the saved, confirmed harness once and says what it found. */
  check(config: Config): Promise<string>;
}>) {
  function SettingsTab({ agent, save, settingsHost }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [rows, setRows] = useState(() => rowsOf(saved.env));
    // Untouched, the stored argv stays exact, so one the box can't show is refused.
    const [args, setArgs] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirming, setConfirming] = useState(false);
    const [confirmError, setConfirmError] = useState("");
    const [checking, setChecking] = useState(false);
    const [checked, setChecked] = useState<{ ready: boolean; text: string }>();
    // Problems in an edit wait until the owner leaves a field or saves.
    const [touched, setTouched] = useState(false);
    // The env control to focus once rows re-render, after Add or Remove.
    const env = useRef<HTMLFieldSetElement>(null);
    const [focusing, setFocusing] = useState<string>();
    useEffect(() => {
      if (focusing === undefined) return;
      env.current?.querySelector<HTMLElement>(focusing)?.focus();
      setFocusing(undefined);
    }, [focusing]);
    // A preset switch needs a new confirmation, even back to the same command.
    const [reset, setReset] = useState(false);
    const current = useApproved(saved) && !reset;
    const edited: Config = {
      ...draft,
      approval: reset ? "" : saved.approval,
      args:
        args === undefined ? saved.args : args === "" ? [] : args.split("\n"),
      env: envOf(rows),
    };
    const configChanged = JSON.stringify(edited) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const found = problems(edited);
    const shown = touched || !configChanged ? found : [];
    const launchChanged =
      JSON.stringify([
        edited.command,
        edited.args,
        edited.env,
        edited.workspace,
      ]) !==
      JSON.stringify([saved.command, saved.args, saved.env, saved.workspace]);
    const run = async (work: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await work();
      } catch (reason) {
        setError(message(reason));
      } finally {
        setBusy(false);
      }
    };
    // Saving a launch the owner hasn't confirmed drops the approval.
    const submit = () => {
      setTouched(true);
      if (found.length > 0) return;
      return run(async () => {
        await save(
          (await approved(edited)) ? edited : { ...edited, approval: "" },
        );
        setChecked(undefined);
        setReset(false);
        setTouched(false);
      });
    };
    const closeDialog = () => {
      setConfirming(false);
      setConfirmError("");
    };
    // Its failure stays in the dialog, where Confirm can be tried again.
    const confirm = async () => {
      setBusy(true);
      setConfirmError("");
      try {
        await save(await approve(saved));
        setConfirming(false);
      } catch (reason) {
        setConfirmError(message(reason));
      } finally {
        setBusy(false);
      }
    };
    const runCheck = async () => {
      setChecking(true);
      setChecked(undefined);
      try {
        const text = await check(saved);
        setChecked({ ready: text === READY, text });
      } catch (reason) {
        setChecked({ ready: false, text: message(reason) });
      } finally {
        setChecking(false);
      }
    };
    const removeRow = (index: number) => {
      const next = rows.filter((_, i) => i !== index);
      setRows(next);
      // The row that took its place, else the one before, else Add.
      const target = Math.min(index, next.length - 1);
      setFocusing(
        target < 0 ? "[data-env-add]" : `[data-env-remove="${target}"]`,
      );
    };
    return (
      <form
        className="grid gap-4"
        onBlur={(event) => {
          if (event.target.matches("input, textarea")) setTouched(true);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {settingsHost?.typeControl?.(configChanged)}
        <Select
          label="Harness"
          variant="field"
          value={draft.preset}
          groups={PRESET_GROUPS}
          onValueChange={(id) => {
            const next = withPreset(edited, id);
            setDraft(next);
            setArgs(next.args.join("\n"));
            setReset(true);
          }}
        />
        <Field
          label="Command"
          description="A program on your PATH or an absolute path. It runs without a shell."
        >
          <Input
            value={draft.command}
            onValueChange={(command) =>
              setDraft({ ...draft, command, preset: CUSTOM })
            }
          />
        </Field>
        <Field label="Arguments" description="One argument per line.">
          <Textarea
            value={args ?? saved.args.join("\n")}
            onChange={(event) => {
              setArgs(event.target.value);
              setDraft({ ...draft, preset: CUSTOM });
            }}
          />
        </Field>
        <fieldset ref={env} className="grid gap-2">
          <legend>Environment</legend>
          <p>
            Extra variables for the harness. Values are hidden, except PATH.
          </p>
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place.
            <div key={index} className="flex gap-2">
              <Input
                aria-label={`Name of ${rowLabel(row, index)}`}
                data-env-name={index}
                value={row.name}
                onValueChange={(name) =>
                  setRows(replaced(rows, index, { ...row, name }))
                }
              />
              <Input
                aria-label={`Value of ${rowLabel(row, index)}`}
                type={row.name.trim() === "PATH" ? "text" : "password"}
                value={row.value}
                onValueChange={(value) =>
                  setRows(replaced(rows, index, { ...row, value }))
                }
              />
              <Button
                aria-label={`Remove ${rowLabel(row, index)}`}
                data-env-remove={index}
                onClick={() => removeRow(index)}
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              data-env-add=""
              onClick={() => {
                setRows([...rows, { name: "", value: "" }]);
                setFocusing(`[data-env-name="${rows.length}"]`);
              }}
            >
              Add variable
            </Button>
          </div>
        </fieldset>
        <Field
          label="Workspace"
          description="The folder the harness works in. Use ~/ for your home folder."
        >
          <Input
            value={draft.workspace}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <AgentInstructions
          value={draft.instructions}
          disabled={false}
          description="Sent ahead of the first message of every session."
          onChange={(instructions) => setDraft({ ...draft, instructions })}
        />
        {shown.map((problem) => (
          <p key={problem} role="alert" className="buzz-field-error">
            {problem}
          </p>
        ))}
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
        <p>
          {launchChanged
            ? "You changed the command. After you save, confirm it again before the agent can run."
            : current
              ? "You confirmed this command."
              : "This command needs your confirmation before the agent can run."}
        </p>
        {checked &&
          (checked.ready ? (
            <p role="status">{checked.text}</p>
          ) : (
            <p role="alert" className="buzz-field-error">
              Check failed: {checked.text}
            </p>
          ))}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="prominent"
            loading={busy}
            disabled={!changed}
            focusableWhenDisabled
          >
            Save
          </Button>
          <Button
            disabled={configChanged || current || problems(saved).length > 0}
            onClick={() => setConfirming(true)}
          >
            Confirm command
          </Button>
          <Button
            loading={checking}
            disabled={configChanged || !current || busy}
            onClick={runCheck}
          >
            Check
          </Button>
        </div>
        {confirming && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) closeDialog();
            }}
            title="Run this command?"
            description="This agent runs exactly this, with your permissions, each time it starts."
            actions={
              <>
                <Button onClick={closeDialog}>Cancel</Button>
                <Button variant="prominent" loading={busy} onClick={confirm}>
                  Confirm
                </Button>
              </>
            }
          >
            <Confirmation value={saved} />
            {confirmError && (
              <p role="alert" className="buzz-field-error">
                Couldn't save your confirmation: {confirmError}
              </p>
            )}
          </Dialog>
        )}
      </form>
    );
  }

  function HistoryTab() {
    return <p>History isn't available for ACP agents.</p>;
  }

  return { SettingsTab, HistoryTab };
}
