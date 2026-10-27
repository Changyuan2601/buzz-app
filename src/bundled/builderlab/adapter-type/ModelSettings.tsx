import { useEffect, useRef, useState } from "react";
import { useAgentSaveState } from "../../../features/agents/AgentSaveButton";
import { Button } from "../../../shared/design-system/ui/Button";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { Select } from "../../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import { useToastNotification } from "../../../shared/design-system/ui/Toast";
import type {
  AgentClient,
  RemoteAgent,
  RemoteAgentModel,
} from "../agents/client";
import type { OAuthSession } from "../oauth/session";

const statuses = {
  "setup-required": "Choose a model and reasoning effort to finish setup.",
  "model-unavailable":
    "The saved model is no longer available. Choose another model and reasoning effort.",
  "effort-unsupported":
    "The saved reasoning effort is no longer supported. Choose a supported effort.",
  unknown:
    "The server has not confirmed the saved model selection. Choose a model and reasoning effort.",
};
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Could not load model settings.";

export function ModelSettings({
  client,
  session,
  agent,
  subject,
  active = true,
}: {
  client: AgentClient;
  session: OAuthSession;
  agent: RemoteAgent;
  subject: string;
  active?: boolean;
}) {
  const notify = useToastNotification();
  const [saved, setSaved] = useState(agent);
  const [models, setModels] = useState<readonly RemoteAgentModel[]>();
  const [modelId, setModelId] = useState(agent.modelId ?? "");
  const [effort, setEffort] = useState(agent.reasoningEffort ?? "");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries a failed catalog request while keeping the draft.
  useEffect(() => {
    const current = new AbortController();
    setBusy(true);
    setCatalogError("");
    void client
      .modelCatalog(current.signal)
      .then(
        (catalog) => {
          if (!current.signal.aborted) setModels(catalog);
        },
        (reason) => {
          if (!current.signal.aborted) setCatalogError(message(reason));
        },
      )
      .finally(() => {
        if (!current.signal.aborted) setBusy(false);
      });
    return () => current.abort();
  }, [client, revision]);
  const model = models?.find((choice) => choice.id === modelId);
  const valid = !!model?.supportedReasoningEfforts.includes(effort);
  const changed =
    modelId !== (saved.modelId ?? "") ||
    effort !== (saved.reasoningEffort ?? "");
  useAgentSaveState(changed, busy, active);
  const save = async () => {
    if (!valid || busy) return;
    const signal = controller.current?.signal;
    if (!signal) return;
    setBusy(true);
    setError("");
    try {
      await session.ensureSignedIn(signal);
      if (session.credential().account.subject !== subject)
        throw new Error(
          "Sign in to the Builderlab account that loaded these model settings.",
        );
      await client.updateModel(saved, modelId, effort, signal);
      const remote = (await client.list(signal)).find(
        (row) => row.pubkey === saved.pubkey,
      );
      signal.throwIfAborted();
      if (!remote)
        throw new Error("Agent not found in this Builderlab account.");
      setSaved(remote);
      setModelId(remote.modelId ?? "");
      setEffort(remote.reasoningEffort ?? "");
      if (remote.modelSelectionStatus === "valid")
        notify("Model preferences saved", "success");
    } catch (reason) {
      if (!signal.aborted) setError(message(reason));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="grid gap-3">
      <InlineHeader title="Model" />
      <SettingsGroup layout="form">
        {saved.modelSelectionStatus !== "valid" && (
          <p role="status" className="m-0 text-body-sm text-warning">
            {statuses[saved.modelSelectionStatus ?? "unknown"]}
            {saved.modelId &&
              ` Saved model: ${models?.find((choice) => choice.id === saved.modelId)?.displayName ?? saved.modelId}.`}
            {saved.reasoningEffort &&
              ` Saved effort: ${saved.reasoningEffort}.`}
          </p>
        )}
        {models ? (
          models.length ? (
            <>
              <Select
                label="Model"
                variant="field"
                value={model ? modelId : ""}
                placeholder="Choose a model"
                disabled={busy}
                groups={[
                  {
                    label: "Models",
                    options: models.map((choice) => ({
                      value: choice.id,
                      label: choice.displayName,
                    })),
                  },
                ]}
                onValueChange={(next) => {
                  setModelId(next);
                  setEffort("");
                }}
              />
              <Select
                label="Reasoning effort"
                variant="field"
                value={valid ? effort : ""}
                placeholder="Choose reasoning effort"
                disabled={busy || !model}
                groups={[
                  {
                    label: "Supported reasoning efforts",
                    options: (model?.supportedReasoningEfforts ?? []).map(
                      (value) => ({ value, label: value }),
                    ),
                  },
                ]}
                onValueChange={setEffort}
              />
              <div>
                <Button
                  variant="prominent"
                  loading={busy}
                  disabled={
                    !valid ||
                    (!changed && saved.modelSelectionStatus === "valid")
                  }
                  onClick={() => void save()}
                >
                  Save model
                </Button>
              </div>
            </>
          ) : (
            <p className="m-0 text-body-sm text-secondary">
              No models are available. Retry when the catalog is available.
            </p>
          )
        ) : (
          busy && (
            <p className="m-0 text-body-sm text-secondary">Loading models…</p>
          )
        )}
        {(catalogError || error) && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {catalogError || error}
          </p>
        )}
        {(catalogError || error || models?.length === 0) && (
          <div>
            <Button
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              {catalogError || models?.length === 0
                ? "Retry models"
                : "Refresh models"}
            </Button>
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
