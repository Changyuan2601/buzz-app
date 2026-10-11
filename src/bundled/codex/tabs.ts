import type * as ReactModule from "react";
import type { ReactNode } from "react";
import type { AgentViewProps } from "../../features/agents/service";
import {
  config,
  effortName,
  validWorkspace,
  type Config,
  type Model,
} from "./config";
import { AppServer, listModels, type Spawn } from "./rpc";
import type { CodexRuntime } from "./runtime";

type Catalog = { models: Model[]; account: string };
/** Read-only setup/catalog discovery uses the same declared native transport. */
async function catalog(spawn: Spawn, signal: AbortSignal) {
  const rpc = new AppServer();
  const abort = () => {
    void rpc.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.open(spawn);
    signal.throwIfAborted();
    const account = await rpc.request<{
      account: { type: string; email?: string } | null;
    }>("account/read");
    if (!account.account)
      throw new Error(
        "Codex needs you to sign in. Run codex login in a terminal, then check again.",
      );
    const models = await listModels(rpc);
    return { models, account: account.account.email ?? account.account.type };
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}

// Installed plugins use host React and its shared control classes, as #732 does.
export function createTabs(
  React: typeof ReactModule,
  spawn: Spawn,
  runtime: CodexRuntime,
) {
  const h = React.createElement;
  const button = (label: string, onClick: () => void, disabled = false) =>
    h(
      "button",
      {
        type: "button",
        onClick,
        disabled,
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": "secondary",
        "data-size": "md",
      },
      h("span", { className: "buzz-button-label" }, label),
    );
  const field = (
    id: string,
    label: string,
    control: ReactNode,
    description?: string,
  ) =>
    h(
      "div",
      {
        "data-buzz-ui": "",
        className: "buzz-field",
      },
      h("label", { htmlFor: id, className: "buzz-field-label" }, label),
      control,
      description
        ? h("p", { className: "buzz-field-description" }, description)
        : null,
    );
  function useCatalog() {
    const [data, setData] = React.useState<Catalog>();
    const [error, setError] = React.useState("");
    const [checking, setChecking] = React.useState(true);
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
      let current = true;
      const abort = new AbortController();
      setChecking(true);
      setError("");
      void catalog(spawn, abort.signal)
        .then(
          (value) => {
            if (current) setData(value);
          },
          (reason) => {
            if (current) {
              setData(undefined);
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          },
        )
        .finally(() => {
          if (current) setChecking(false);
        });
      return () => {
        current = false;
        abort.abort();
      };
    }, [attempt]);
    return {
      data,
      error,
      checking,
      retry: () => setAttempt((value) => value + 1),
    };
  }
  function CodexTab({ agent }: AgentViewProps<Config>) {
    const { data, error, checking, retry } = useCatalog();
    const sessions = React.useSyncExternalStore(runtime.subscribe, () =>
      runtime.sessions(agent.pubkey),
    );
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-4)" } },
      h(
        "p",
        { role: "status" },
        checking
          ? "Checking Codex…"
          : data
            ? `Codex is ready (${data.account}).`
            : "Codex needs attention.",
      ),
      error ? h("p", { role: "alert" }, error) : null,
      button("Check again", retry, checking),
      h(
        "p",
        { className: "buzz-field-description" },
        "Uses your existing Codex sign-in. Install Codex and run codex login in a terminal if needed.",
      ),
      h("h3", { style: { fontSize: "inherit", margin: 0 } }, "Conversations"),
      sessions.length
        ? h(
            "ul",
            {
              style: {
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "grid",
                gap: "var(--space-4)",
              },
            },
            sessions.map((session) =>
              h(
                "li",
                { key: session.key },
                h(
                  "p",
                  null,
                  h("code", null, session.key),
                  " · ",
                  session.status,
                ),
                session.detail
                  ? h(
                      "pre",
                      {
                        style: {
                          whiteSpace: "pre-wrap",
                          maxHeight: "12rem",
                          overflow: "auto",
                          fontSize: "0.75rem",
                        },
                      },
                      session.detail,
                    )
                  : null,
              ),
            ),
          )
        : h(
            "p",
            { className: "buzz-field-description" },
            "Mention this agent in a channel to start a conversation.",
          ),
      h(
        "p",
        { className: "buzz-field-description" },
        "Only your messages trigger this agent. New mentions steer active work and continue the same session when idle. Event watches work for your messages; timers are not supported yet.",
      ),
    );
  }
  function SettingsTab({ agent, save }: AgentViewProps<Config>) {
    const saved = config(agent.config);
    const [draft, setDraft] = React.useState(saved);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState("");
    const { data, error: catalogError, checking, retry } = useCatalog();
    React.useEffect(() => {
      setDraft(config(agent.config));
    }, [agent.config]);
    const selected =
      data?.models.find((model) => model.model === draft.model) ??
      (!draft.model
        ? data?.models.find((model) => model.isDefault)
        : undefined);
    const set = (patch: Partial<Config>) =>
      setDraft((current) => ({ ...current, ...patch }));
    const control = {
      "data-buzz-ui": "",
      "data-size": "md",
      className: "buzz-input",
    };
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const settings = config(draft);
        if (!validWorkspace(settings.workspace))
          throw new Error("Enter an absolute workspace path or ~/.buzz.");
        await save(settings);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setSaving(false);
      }
    };
    return h(
      "form",
      {
        style: { display: "grid", gap: "var(--space-4)" },
        onSubmit: (event: { preventDefault(): void }) => {
          event.preventDefault();
          void submit();
        },
      },
      catalogError
        ? h(
            "div",
            { role: "alert" },
            catalogError,
            button("Check again", retry, checking),
          )
        : null,
      field(
        "codex-model",
        "Model",
        h(
          "select",
          {
            ...control,
            id: "codex-model",
            value: draft.model,
            disabled: checking || saving,
            onChange: (event: { target: { value: string } }) => {
              const model = data?.models.find(
                (candidate) => candidate.model === event.target.value,
              );
              set({
                model: event.target.value,
                effort: model?.defaultReasoningEffort ?? "",
              });
            },
          },
          h(
            "option",
            { value: "" },
            selected && !draft.model
              ? `Codex default · ${selected.displayName}`
              : "Codex default",
          ),
          draft.model &&
            !data?.models.some((model) => model.model === draft.model)
            ? h(
                "option",
                { value: draft.model },
                `${draft.model} (unavailable)`,
              )
            : null,
          ...(data?.models.map((model) =>
            h(
              "option",
              { key: model.model, value: model.model },
              model.displayName,
            ),
          ) ?? []),
        ),
        selected?.description,
      ),
      field(
        "codex-effort",
        "Thinking",
        h(
          "select",
          {
            ...control,
            id: "codex-effort",
            value: draft.effort,
            disabled: checking || saving || !selected,
            onChange: (event: { target: { value: string } }) =>
              set({ effort: event.target.value }),
          },
          h("option", { value: "" }, "Model default"),
          draft.effort &&
            !selected?.supportedReasoningEfforts.some(
              (effort) => effort.reasoningEffort === draft.effort,
            )
            ? h(
                "option",
                { value: draft.effort },
                `${effortName(draft.effort)} (unavailable)`,
              )
            : null,
          ...(selected?.supportedReasoningEfforts.map((effort) =>
            h(
              "option",
              { key: effort.reasoningEffort, value: effort.reasoningEffort },
              effortName(effort.reasoningEffort),
            ),
          ) ?? []),
        ),
      ),
      field(
        "codex-workspace",
        "Workspace",
        h("input", {
          ...control,
          id: "codex-workspace",
          value: draft.workspace,
          placeholder: "~/.buzz",
          disabled: saving,
          onChange: (event: { target: { value: string } }) =>
            set({ workspace: event.target.value }),
        }),
        "Codex starts here with full access to your files and network. Buzz tools run inside the app. Inherited MCP/Apps/plugin tools are disabled.",
      ),
      field(
        "codex-scope",
        "Sessions",
        h(
          "select",
          {
            ...control,
            id: "codex-scope",
            value: draft.scope,
            disabled: saving,
            onChange: (event: { target: { value: string } }) =>
              set({
                scope: event.target.value === "channel" ? "channel" : "thread",
              }),
          },
          h("option", { value: "thread" }, "One session per thread"),
          h("option", { value: "channel" }, "One session per channel"),
        ),
        "DMs always share one conversation.",
      ),
      field(
        "codex-instructions",
        "Instructions",
        h("textarea", {
          "data-buzz-ui": "",
          className: "buzz-textarea",
          id: "codex-instructions",
          value: draft.instructions,
          rows: 6,
          disabled: saving,
          onChange: (event: { target: { value: string } }) =>
            set({ instructions: event.target.value }),
        }),
        "Buzz guidance supplements Codex’s native instructions. Saved changes apply to the next turn. A workspace change starts a fresh session.",
      ),
      error
        ? h("p", { role: "alert", className: "buzz-field-error" }, error)
        : null,
      h(
        "div",
        null,
        h(
          "button",
          {
            type: "submit",
            disabled: saving || JSON.stringify(draft) === JSON.stringify(saved),
            "aria-busy": saving || undefined,
            "data-buzz-ui": "",
            className: "buzz-button",
            "data-variant": "prominent",
            "data-size": "md",
          },
          h(
            "span",
            { className: "buzz-button-label" },
            saving ? "Saving…" : "Save",
          ),
        ),
      ),
    );
  }
  return { CodexTab, SettingsTab };
}
