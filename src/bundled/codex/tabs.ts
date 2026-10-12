import type * as ReactModule from "react";
import type { ReactNode } from "react";
import type { AgentViewProps } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import {
  config,
  effortName,
  validWorkspace,
  type Config,
  type Model,
} from "./config";
import { AppServer, listModels, type Spawn } from "./rpc";
import type { CodexRuntime } from "./runtime";
import type { CodexSetup, Step } from "./setup";

type Catalog = { models: Model[]; account: string };
class SignedOut extends Error {}
/** The setup step a failed check calls for, if any. */
const needed = (reason: unknown): Step | undefined =>
  reason instanceof SignedOut
    ? "login"
    : // Native rejects with a string, reporting a program it cannot find as a
      // failure to start it.
      /could not start/i.test(
          reason instanceof Error ? reason.message : String(reason),
        )
      ? "install"
      : undefined;
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
    if (!account.account) throw new SignedOut();
    const models = await listModels(rpc);
    return { models, account: account.account.email ?? account.account.type };
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}

// Uses host React and its shared control classes, as #732 does; setup actions
// use the shared Button for its loading state.
export function createTabs(
  React: typeof ReactModule,
  spawn: Spawn,
  runtime: CodexRuntime,
  setup: CodexSetup,
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
    const [need, setNeed] = React.useState<Step>();
    const [checking, setChecking] = React.useState(true);
    const [attempt, setAttempt] = React.useState(0);
    const { finished } = React.useSyncExternalStore(
      setup.subscribe,
      setup.snapshot,
    );
    React.useEffect(() => {
      let current = true;
      const abort = new AbortController();
      setChecking(true);
      setError("");
      void catalog(spawn, abort.signal)
        .then(
          (value) => {
            // Agents' shared server may have started before this sign-in.
            void runtime.reauthorize();
            if (current) {
              setData(value);
              setNeed(undefined);
            }
          },
          (reason) => {
            if (current) {
              const step = needed(reason);
              setData(undefined);
              setNeed(step);
              setError(
                step === "install"
                  ? "Codex is not installed. Install it from the Codex tab."
                  : step === "login"
                    ? "Codex needs you to sign in. Sign in from the Codex tab."
                    : reason instanceof Error
                      ? reason.message
                      : String(reason),
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
    }, [attempt, finished]);
    return {
      data,
      error,
      need,
      checking,
      retry: () => setAttempt((value) => value + 1),
    };
  }
  function CodexTab({ agent }: AgentViewProps<Config>) {
    const { data, error, need, checking, retry } = useCatalog();
    const { running, output } = React.useSyncExternalStore(
      setup.subscribe,
      setup.snapshot,
    );
    const sessions = React.useSyncExternalStore(runtime.subscribe, () =>
      runtime.sessions(agent.pubkey),
    );
    // On Linux, `codex login` can start a browser that was not running inside
    // the login's process group, which the host kills when sign-in ends.
    const signInHere = !/Linux/i.test(navigator.platform);
    // One button per slot, so focus stays put as Install becomes Sign in and
    // Cancel becomes Check again.
    const action =
      need === "install"
        ? ({ step: "install", label: "Install Codex" } as const)
        : need === "login" && signInHere
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
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
            : need === "install"
              ? "Codex is not installed."
              : need === "login"
                ? "Codex needs you to sign in."
                : "Codex needs attention.",
      ),
      error && !need ? h("p", { role: "alert" }, error) : null,
      h(
        "div",
        { className: "flex flex-wrap gap-2" },
        action
          ? h(Button, {
              variant: "prominent",
              loading: running === action.step,
              // Until the check after a step ends, a second run could repeat it.
              disabled: running ? running !== action.step : checking,
              focusableWhenDisabled: true,
              onClick: () => void setup.run(action.step),
              children: action.label,
            })
          : null,
        h(Button, {
          variant: "ghost",
          disabled: !running && checking,
          focusableWhenDisabled: true,
          onClick: () => void (running ? setup.cancel() : retry()),
          children: running ? "Cancel" : "Check again",
        }),
      ),
      need === "install"
        ? h(
            "p",
            { className: "buzz-field-description" },
            "Runs the official installer, ",
            h(
              "code",
              null,
              "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            ),
            ", which puts ",
            h("code", null, "codex"),
            " in ",
            h("code", null, "~/.local/bin"),
            ".",
          )
        : need === "login" && !signInHere
          ? h(
              "p",
              { className: "buzz-field-description" },
              "Run ",
              h("code", null, "codex login"),
              " in a terminal, then check again. If the terminal cannot find ",
              h("code", null, "codex"),
              ", run ",
              // The installer leaves the shell profile alone when it sees
              // ~/.local/bin on the PATH Buzz gives it.
              h("code", null, "~/.local/bin/codex login"),
              ".",
            )
          : null,
      output
        ? h(
            "pre",
            {
              role: "log",
              "aria-label": "Setup output",
              className:
                "m-0 max-h-60 overflow-auto whitespace-pre-wrap text-caption",
            },
            output,
          )
        : null,
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
