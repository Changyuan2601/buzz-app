import { useEffect, useState } from "react";
import type { AgentControl } from "../../features/agents/control";
import type { ModelCatalog } from "../../features/agents/models";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { agentEdit, type AgentDraft } from "./agent-edit";

/** Donor shared-compute selection: automatic routing plus community models. */
export function SharedComputeModelPicker({
  id,
  draft,
  control,
  disabled,
  onChange,
}: {
  id?: string | undefined;
  draft: AgentDraft;
  control: AgentControl;
  disabled: boolean;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Native resolves saved write-only values and inherited defaults. Model choice
  // alone does not invalidate discovery or trigger another network request.
  const request = JSON.stringify({
    id,
    expectedRevision: id ? draft.revision : undefined,
    draft: {
      command: draft.command,
      args: draft.args,
      provider: draft.provider,
      workspace: draft.workspace,
      environment: draft.environment,
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit retry.
  useEffect(() => {
    const run = new AbortController();
    setCatalog(null);
    setError("");
    setBusy(true);
    if (!control.models) {
      setError("Model discovery requires a rebuilt desktop app.");
      setBusy(false);
      return () => run.abort();
    }
    let edit: ReturnType<typeof agentEdit>;
    const context = JSON.parse(request);
    try {
      edit = agentEdit(
        {
          ...context.draft,
          // Discovery applies this edit only to a native clone, never Save.
          // Saved-agent validation still requires a nonempty name.
          name: "Model discovery",
          systemPrompt: "",
          sessionPolicy: null,
          model: "",
        },
        true,
      );
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
      return () => run.abort();
    }
    void control.models
      .request(
        {
          id: context.id,
          expectedRevision: context.expectedRevision,
          edit,
          host: "",
          filter: "",
          action: "connect",
        },
        run.signal,
      )
      .then(
        (result) => {
          if (!run.signal.aborted) setCatalog(result);
        },
        (failure) => {
          if (!run.signal.aborted) setError((failure as Error).message);
        },
      )
      .finally(() => {
        if (!run.signal.aborted) setBusy(false);
      });
    return () => run.abort();
  }, [request, control, attempt]);
  const models = catalog?.models ?? [];
  const explicit = !["", "auto", "mesh"].includes(draft.model);
  const missing = explicit && !models.some((model) => model.id === draft.model);
  return (
    <div className="space-y-2">
      <Select
        label="Model"
        variant="field"
        disabled={disabled}
        value={explicit ? draft.model : "auto"}
        groups={[
          {
            label: "",
            options: [
              { value: "auto", label: "Auto (collective when available)" },
              ...models.map((model) => ({
                value: model.id,
                label: model.name,
              })),
              ...(missing
                ? [
                    {
                      value: draft.model,
                      label: `${draft.model} (saved; not currently listed)`,
                    },
                  ]
                : []),
            ],
          },
        ]}
        onValueChange={(model) => onChange({ model })}
      />
      <p className="text-body-sm text-secondary" role="status">
        {busy
          ? "Loading community models…"
          : error ||
            (models.length
              ? "Uses compute shared in this community. No API key required."
              : "No shared models advertised yet. Auto remains available; share compute before starting the agent.")}
      </p>
      <Button
        disabled={disabled || busy}
        onClick={() => setAttempt(attempt + 1)}
      >
        {error ? "Retry models" : "Refresh models"}
      </Button>
      {catalog?.modelOverridden && (
        <p className="text-body-sm text-warning">
          A saved BUZZ_AGENT_MODEL environment override takes precedence over
          this selection.
        </p>
      )}
    </div>
  );
}
