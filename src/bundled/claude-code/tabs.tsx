// The type's tabs: Claude Code's setup on this computer, and the agent's
// settings; and its part of the New agent dialog.
import { useEffect, useState, useSyncExternalStore } from "react";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { CreateCorner } from "../../features/agents/create-card";
import { ModelPicker } from "../../features/agents/ModelPicker";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  type ClaudeRuntime,
  type Config,
  config as readConfig,
} from "./runtime";
import type { ClaudeSetup } from "./setup";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
// ModelPicker adds Claude Code's own default to these.
const MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
const DEFAULT_MODEL = "Claude Code default";
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);

/** The model and instructions a new agent starts with. */
export function Create({
  config,
  onChange,
  disabled,
}: AgentCreateProps<Config>) {
  const current = readConfig(config);
  return (
    <>
      <CreateCorner>
        <ModelPicker
          compact
          models={MODELS}
          value={current.model}
          defaultLabel={DEFAULT_MODEL}
          disabled={disabled}
          onChange={(model) => onChange({ ...current, model })}
        />
      </CreateCorner>
      <AgentInstructions
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    </>
  );
}

export function createTabs({
  setup,
  runtime,
}: Readonly<{ setup: ClaudeSetup; runtime: ClaudeRuntime }>) {
  /** Claude Code on this computer, and what this agent has running. */
  function ClaudeTab({ agent }: AgentViewProps<Config>) {
    const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
    const sessions = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.pubkey),
    );
    const [code, setCode] = useState("");
    useEffect(() => {
      void setup.check();
    }, []);
    const status = state.status;
    const line =
      !status || state.checking
        ? "Checking Claude Code…"
        : status.state === "missing"
          ? "Claude Code is not installed."
          : status.state === "signed-out"
            ? `Claude Code ${status.version} needs you to sign in.`
            : status.state === "ready"
              ? `Claude Code ${status.version} is ready${status.account ? ` (${status.account})` : ""}.`
              : status.message;
    // One button per slot, so focus stays put as Install becomes Sign in and
    // Cancel becomes Check again.
    const action =
      status?.state === "missing"
        ? ({ step: "install", label: "Install Claude Code" } as const)
        : status?.state === "signed-out"
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
    return (
      <div className="grid gap-4">
        <section className="grid gap-2">
          <p role="status" className="m-0">
            {line}
          </p>
          <div className="flex flex-wrap gap-2">
            {action && (
              <Button
                variant="prominent"
                loading={state.running === action.step}
                disabled={!!state.running && state.running !== action.step}
                onClick={() => void setup.run(action.step)}
              >
                {action.label}
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={!state.running && state.checking}
              focusableWhenDisabled
              onClick={() =>
                void (state.running ? setup.cancel() : setup.check())
              }
            >
              {state.running ? "Cancel" : "Check again"}
            </Button>
          </div>
          {status?.state === "missing" && (
            <p className="m-0 text-body-sm text-subtle">
              Runs the official installer,{" "}
              <code>curl -fsSL https://claude.ai/install.sh | bash</code>, which
              puts <code>claude</code> in <code>~/.local/bin</code>.
            </p>
          )}
          {state.output && (
            <pre
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-caption"
            >
              {state.output}
            </pre>
          )}
          {state.running === "login" && (
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void setup.answer(code);
                setCode("");
              }}
            >
              <Field
                label="Sign-in code"
                description="If the browser shows a code to paste, enter it here."
              >
                <Input value={code} onValueChange={setCode} />
              </Field>
              <Button type="submit" disabled={!code.trim()}>
                Send
              </Button>
            </form>
          )}
        </section>
        <section className="grid gap-1">
          <h3 className="m-0 text-body">Running sessions</h3>
          {sessions.length ? (
            <ul className="m-0 grid list-none gap-1 p-0">
              {sessions.map((session) => (
                <li key={session.key} className="flex justify-between gap-2">
                  <code className="truncate">{session.key}</code>
                  <span>{session.busy ? "Working" : "Idle"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation's session starts when the agent is mentioned.
            </p>
          )}
        </section>
      </div>
    );
  }

  /** What the agent runs with. Saving restarts idle sessions with the change. */
  function SettingsTab({ agent, save }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          workspace: draft.workspace.trim() || "~/.buzz",
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ModelPicker
          models={MODELS}
          value={draft.model}
          defaultLabel={DEFAULT_MODEL}
          onChange={(model) => setDraft({ ...draft, model })}
        />
        <Field
          label="Workspace"
          description="The folder Claude Code works in. Use ~/ for your home folder."
        >
          <Input
            value={draft.workspace}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <Select
          label="Sessions"
          variant="field"
          value={draft.scope}
          groups={SCOPES}
          onValueChange={(value) =>
            setDraft({
              ...draft,
              scope: value === "channel" ? "channel" : "thread",
            })
          }
        />
        <AgentInstructions
          value={draft.instructions}
          disabled={false}
          description="Added to every session's system prompt, after Buzz's own."
          onChange={(instructions) => setDraft({ ...draft, instructions })}
        />
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
        <div>
          {/* Stays focusable while saving and once there is nothing to save. */}
          <Button
            type="submit"
            variant="prominent"
            loading={saving}
            disabled={!changed}
            focusableWhenDisabled
          >
            Save
          </Button>
        </div>
      </form>
    );
  }

  return { ClaudeTab, SettingsTab };
}
