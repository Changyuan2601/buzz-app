import { useId, useState, useSyncExternalStore } from "react";
import type { Agents, AgentCreateProps } from "../../features/agents/service";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Select } from "../../shared/design-system/ui/Select";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { DEFAULT_MESH_AGENT_CONFIG, meshAgentConfig } from "./meshAgent";
import { MESH_AGENT_PRESETS, type MeshAgentPreset } from "./meshAgentPresets";

/** The helper is chosen before creation; the existing dialog owns consent. */
export function MeshHelpers({
  agents,
  community,
}: {
  agents: Agents;
  community: string;
}) {
  const state = useSyncExternalStore(agents.subscribe, agents.snapshot);
  const title = useId();
  const [chosen, setChosen] = useState<MeshAgentPreset | null>();
  const [created, setCreated] = useState("");
  const type = agents
    .types()
    .find(
      (item) => item.pluginId === "buzz.mesh-compute" && item.id === "mesh",
    );
  return (
    <section aria-labelledby={title} className="grid gap-3">
      <InlineHeader
        id={title}
        title="Helpers"
        subtitle="Create a helper that runs on this community’s shared compute. Review its name and instructions before creating it."
      />
      <SettingsGroup>
        {[...MESH_AGENT_PRESETS, null].map((preset) => {
          const name = preset?.name ?? "Custom agent";
          return (
            <PreferenceRow
              key={preset?.id ?? "custom"}
              title={name}
              subtitle={preset?.summary ?? "Start with your own instructions."}
              trailing={
                <Button
                  size="sm"
                  disabled={!type || state.status !== "ready"}
                  aria-label={`Set up ${name}`}
                  onClick={() => {
                    setCreated("");
                    setChosen(preset);
                  }}
                >
                  Set up
                </Button>
              }
            />
          );
        })}
      </SettingsGroup>
      {state.status !== "ready" && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {state.error ??
            "Waiting for agents to be available in this community."}
        </p>
      )}
      {created && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {created} created. Open Agents to configure its Attention and add it
          to a conversation.
        </p>
      )}
      {chosen !== undefined && type && state.status === "ready" && (
        <AgentCreateDialog
          agents={agents}
          detailsLayout="form"
          types={[{ ...type, Create: MeshHelperCreate }]}
          community={community}
          initial={{
            name: chosen?.name ?? "",
            config: {
              ...DEFAULT_MESH_AGENT_CONFIG,
              ...(chosen
                ? {
                    preset: chosen.id,
                    prompt: chosen.prompt,
                    mode: chosen.mode,
                  }
                : {}),
            },
          }}
          onClose={() => setChosen(undefined)}
          onCreated={(agent) => {
            setChosen(undefined);
            setCreated(agent.name);
          }}
        />
      )}
    </section>
  );
}

function MeshHelperCreate({ config, onChange, disabled }: AgentCreateProps) {
  const draft = meshAgentConfig(config);
  return (
    <div className="grid gap-3">
      <Select
        label="Mode"
        variant="field"
        value={draft.mode}
        disabled={disabled}
        groups={[
          {
            label: "",
            options: [
              { value: "chat", label: "Chat — no tools" },
              { value: "workspace", label: "Workspace — shell and files" },
              { value: "full", label: "Full — shell, files and Buzz" },
            ],
          },
        ]}
        onValueChange={(value) =>
          onChange({
            ...draft,
            mode: value === "chat" || value === "workspace" ? value : "full",
          })
        }
      />
      {draft.mode !== "chat" && (
        <Field label="Workspace" description="An absolute path, or ~/.buzz.">
          <Input
            required
            pattern="(/.*|[A-Za-z]:[/\\\\].*|~/.buzz)"
            disabled={disabled}
            value={draft.workspace}
            onChange={(event) =>
              onChange({ ...draft, workspace: event.target.value })
            }
          />
        </Field>
      )}
      <Select
        label="Sessions"
        variant="field"
        value={draft.scope}
        disabled={disabled}
        groups={[
          {
            label: "",
            options: [
              { value: "thread", label: "One session per thread" },
              { value: "channel", label: "One session per channel" },
            ],
          },
        ]}
        onValueChange={(value) =>
          onChange({
            ...draft,
            scope: value === "channel" ? "channel" : "thread",
          })
        }
      />
      <Field label="Instructions">
        <Textarea
          rows={8}
          value={draft.prompt}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, prompt: event.target.value })
          }
        />
      </Field>
    </div>
  );
}
