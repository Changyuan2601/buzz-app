// The Foundation Model agent's New agent choices and settings: its
// instructions, and whether the model can answer on this computer.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../buzz-mcp/rpc";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { INSTRUCTIONS_CHARS } from "./prompt";
import { type Config, type FmRuntime, config as readConfig } from "./runtime";

type Availability = Awaited<ReturnType<FmRuntime["available"]>>;

export function createTabs(runtime: Pick<FmRuntime, "available">) {
  /** What `fm available` says, read when shown and on request. */
  function Availability() {
    const [state, setState] = useState<Availability | undefined>();
    const latest = useRef(0);
    const check = useCallback(() => {
      const at = ++latest.current;
      setState(undefined);
      void runtime.available().then((next) => {
        if (latest.current === at) setState(next);
      });
    }, []);
    useEffect(() => {
      check();
      return () => {
        latest.current++;
      };
    }, [check]);
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body-sm text-secondary">
          {!state
            ? "Checking Apple's on-device model…"
            : state.ready
              ? "Apple's on-device model is ready. It answers without an internet connection."
              : state.detail}
        </p>
        {state && !state.ready && <Button onClick={check}>Check again</Button>}
      </div>
    );
  }

  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <>
        <Availability />
        <AgentInstructions
          creation
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...current, instructions })}
        />
      </>
    );
  }

  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save(draft);
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setSaving(false);
      }
    };
    const typeControl = settingsHost?.typeControl?.(configChanged);
    return (
      <form
        id={form}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && (
          <p
            ref={saveErrorRef}
            tabIndex={-1}
            role="alert"
            className="buzz-field-error"
          >
            {error}
          </p>
        )}
        {settingsSection !== "runtime" && (
          <>
            {typeControl && <SettingsGroup>{typeControl}</SettingsGroup>}
            <AgentInstructions
              value={draft.instructions}
              disabled={false}
              description={`Apple's on-device model has a small context, so keep these short. It reads the first ${INSTRUCTIONS_CHARS.toLocaleString("en-US")} characters.`}
              onChange={(instructions) => setDraft({ ...draft, instructions })}
            />
          </>
        )}
        {settingsSection !== "identity" && <Availability />}
        <AgentSaveButton form={form} saving={saving} disabled={!changed} />
        {settingsSection !== "identity" && settingsContent}
      </form>
    );
  }

  return { Create, SettingsTab };
}
