import { useState } from "react";
import type { AgentViewProps } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { type MeshAgentConfig, meshAgentConfig } from "./meshAgent";

/** The Mesh type's only setting: its prompt. */
export function MeshAgentTab({ agent, save }: AgentViewProps<MeshAgentConfig>) {
  const saved = meshAgentConfig(agent.config).prompt;
  const [prompt, setPrompt] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const changed = prompt !== saved;
  const submit = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await save({ ...meshAgentConfig(agent.config), prompt });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
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
      <Field
        label="Prompt"
        description="The system prompt for every reply. Replies come from this community's shared compute; the agent has no tools."
      >
        <Textarea
          rows={8}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </Field>
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
