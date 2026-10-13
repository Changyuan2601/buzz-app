// goose's New agent choices and agent settings. The provider and its
// credentials come from the owner's goose config; an agent can only name a
// different model or provider from it.
import { useState } from "react";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { type Config, config as readConfig, DEFAULT_CONFIG } from "./runtime";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];

/** The instructions a new agent starts with. */
export function Create({
  config,
  onChange,
  disabled,
}: AgentCreateProps<Config>) {
  const current = readConfig(config);
  return (
    <AgentInstructions
      value={current.instructions}
      disabled={disabled}
      onChange={(instructions) => onChange({ ...current, instructions })}
    />
  );
}

export function SettingsTab({
  agent,
  save,
  settingsHost,
}: AgentViewProps<Config>) {
  const saved = readConfig(agent.config);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
  const changed = configChanged || Boolean(settingsHost?.pendingSave);
  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await save({
        ...draft,
        model: draft.model.trim(),
        provider: draft.provider.trim(),
        workspace: draft.workspace.trim() || DEFAULT_CONFIG.workspace,
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
      {settingsHost?.typeControl?.(configChanged)}
      <Field
        label="Provider"
        description="A goose provider, such as anthropic or openai. Empty uses the one in your goose config."
      >
        <Input
          value={draft.provider}
          placeholder="From goose config"
          onValueChange={(provider) => setDraft({ ...draft, provider })}
        />
      </Field>
      <Field
        label="Model"
        description="A model the provider offers. Empty uses the one in your goose config."
      >
        <Input
          value={draft.model}
          placeholder="From goose config"
          onValueChange={(model) => setDraft({ ...draft, model })}
        />
      </Field>
      <Field
        label="Workspace"
        description="The folder goose works in. Use ~/ for your home folder."
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
