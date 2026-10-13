import { useState } from "react";
import type { AgentViewProps } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  DEFAULT_WORKSPACE,
  type MeshAgentConfig,
  meshAgentConfig,
  validWorkspace,
} from "./meshAgent";

/** The Mesh type's settings: prompt, working directory and how it replies. */
export function MeshAgentTab({ agent, save }: AgentViewProps<MeshAgentConfig>) {
  const saved = meshAgentConfig(agent.config);
  const [prompt, setPrompt] = useState(saved.prompt);
  const [workspace, setWorkspace] = useState(saved.workspace);
  const [reply, setReply] = useState(saved.reply);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const workspaceValid = validWorkspace(workspace);
  const changed =
    prompt !== saved.prompt ||
    workspace.trim() !== saved.workspace ||
    reply !== saved.reply;
  const submit = async () => {
    if (!changed || saving || !workspaceValid) return;
    setSaving(true);
    setError(undefined);
    try {
      await save({ prompt, workspace: workspace.trim(), reply });
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
        description="The system prompt for every reply. Replies come from this community's shared compute."
      >
        <Textarea
          rows={8}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </Field>
      <Field
        label="Workspace"
        description={`Where its shell and file tools run, and where it finds project skills. An absolute path, or ${DEFAULT_WORKSPACE}.`}
        error={workspaceValid ? undefined : "Use an absolute path."}
      >
        <Input
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
        />
      </Field>
      <Field
        label="Replies"
        description={
          reply === "tools"
            ? "Replies with Buzz tools, as Codex and Claude Code agents do: it can read the thread and post as it works."
            : "Its final answer is posted as one reply. Suits smaller models."
        }
      >
        <Switch
          label="Reply with Buzz tools"
          checked={reply === "tools"}
          onCheckedChange={(on) => setReply(on ? "tools" : "direct")}
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
          disabled={!changed || !workspaceValid}
          focusableWhenDisabled
        >
          Save
        </Button>
      </div>
    </form>
  );
}
