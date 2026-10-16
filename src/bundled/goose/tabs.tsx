// goose's New agent choices and agent settings. Providers, their keys and
// their models are goose's own: listed from it, and saved into its config.
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import {
  type ModelChoice,
  ModelPicker,
} from "../../features/agents/ModelPicker";
import {
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import {
  AwsLogoIcon,
  ClaudeLogoIcon,
  DatabricksLogoIcon,
  type DefinedIcon,
  GoogleLogoIcon,
  GooseLogoIcon,
  OpenAILogoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { validWorkspace } from "../codex/config";
import {
  type Config,
  DEFAULT_CONFIG,
  type GooseRuntime,
  config as readConfig,
} from "./runtime";
import {
  type GooseSetup,
  keyLabel,
  type Provider,
  type Providers,
  type Tested,
} from "./setup";
import {
  type GooseHistory,
  type GooseTranscript,
  type Place,
  RECENT_LIMIT,
  TURN_LIMIT,
} from "./transcript";

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

type Choice = Readonly<{ provider: string; model: string }>;

/** Marks for goose's most-used providers, by goose's provider ID. */
const PROVIDER_ICONS: ReadonlyMap<string, DefinedIcon> = new Map([
  ["anthropic", ClaudeLogoIcon],
  ["openai", OpenAILogoIcon],
  ["google", GoogleLogoIcon],
  ["databricks", DatabricksLogoIcon],
  ["aws_bedrock", AwsLogoIcon],
]);
/** The provider's mark, or undefined for one without a mark. */
const providerIcon = (id: string | undefined) => {
  const Icon = id ? PROVIDER_ICONS.get(id) : undefined;
  return Icon && <Icon size={18} aria-hidden="true" />;
};
type Read<T> = (
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T }
) & { scope?: string };

/** `read()` as it settles, read again when `key` changes or on `retry`. A
 * value already shown stays while it is read again, even when that read
 * fails, but only for the same `scope`; another scope's value is never shown. */
function useRead<T>(read: () => Promise<T>, key: string, scope = key) {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` follows `key`.
  useEffect(() => {
    let current = true;
    const kept = (prior: Read<T>) =>
      prior.value === undefined || prior.scope !== scope
        ? {}
        : { value: prior.value, scope };
    setState((prior) => ({ status: "loading", ...kept(prior) }));
    read().then(
      (value) => current && setState({ status: "ready", value, scope }),
      (error: unknown) =>
        current &&
        setState((prior) => ({
          status: "error",
          error: message(error),
          ...kept(prior),
        })),
    );
    return () => {
      current = false;
    };
  }, [key, round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

/** A session the profile can show: one found for a place, or one goose
 * listed by its title. */
type Row = Readonly<{
  key: string;
  sessionId: string;
  title: string;
  channelId: string;
  root?: string;
  at?: number;
}>;
/** `Anthropic · claude-opus-5-5`, or undefined for goose's own default. */
const choiceLabel = (
  { provider, model }: Choice,
  named: (id: string) => string | undefined = (id) => id,
) =>
  [provider && named(provider), model || (provider && "default model")]
    .filter(Boolean)
    .join(" · ") || undefined;
const placeOf = (key: string): Place => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};
/** Buzz titles a session `Agent · place · root`; the agent's name is the
 * profile's own. */
const titled = (name: string, title: string) =>
  title.startsWith(`${name} · `) ? title.slice(name.length + 3) : title;

export function createTabs({
  setup,
  runtime,
  history,
}: Readonly<{
  setup: GooseSetup;
  runtime: GooseRuntime;
  history: GooseHistory;
}>) {
  /** The provider, its key and its model, and a test that they answer. As
   * `rows` of the agent's settings, only the provider and model: the rest is
   * `ProviderSetup`'s. */
  function ProviderFields({
    value,
    onChange,
    disabled = false,
    rows = false,
  }: Readonly<{
    value: Choice;
    onChange(value: Choice): void;
    disabled?: boolean;
    rows?: boolean;
  }>) {
    const [listing, reload] = useRead(() => setup.providers(), "providers");
    // A new key or host can offer other models, so each save reads them again.
    const [saves, setSaves] = useState(0);
    const providers: Providers | undefined = listing.value;
    const fallback = providers?.defaults.provider;
    const id = value.provider || fallback || "";
    const provider = providers?.providers.find((item) => item.id === id);
    const [models] = useRead(
      () => (id ? setup.models(id) : Promise.resolve([] as ModelChoice[])),
      `${id}:${provider?.configured ?? false}:${saves}`,
      id,
    );
    const named = (key: string | undefined) =>
      providers?.providers.find((item) => item.id === key)?.name ?? key;
    const modelDefault = value.provider
      ? provider?.defaultModel
      : (providers?.defaults.model ?? provider?.defaultModel);
    return (
      <>
        <Select
          label="Provider"
          variant={rows ? "preference" : "field"}
          value={value.provider}
          leading={providerIcon(id)}
          {...(rows && !value.provider && fallback
            ? { valueLabel: named(fallback) }
            : {})}
          disabled={disabled || !providers}
          {...(listing.status === "error"
            ? { error: listing.error }
            : listing.status === "loading" && !providers
              ? { description: "Loading goose's providers…" }
              : rows && provider && !provider.configured
                ? { description: `Set up ${provider.name} in Settings.` }
                : {})}
          groups={[
            {
              label: "",
              options: [
                {
                  value: "",
                  label: fallback
                    ? `From goose config (${named(fallback)})`
                    : "From goose config",
                },
                ...(providers?.providers ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                  leading: providerIcon(item.id),
                  description: item.configured ? "Set up" : item.description,
                })),
              ],
            },
          ]}
          onValueChange={(provider) => onChange({ provider, model: "" })}
        />
        {listing.status === "error" && (
          <div>
            <Button onClick={reload}>Try again</Button>
          </div>
        )}
        {!rows && provider && (
          <ProviderKeys
            key={provider.id}
            provider={provider}
            disabled={disabled}
            onSaved={() => {
              reload();
              setSaves((count) => count + 1);
            }}
          />
        )}
        <ModelPicker
          allowCustomModel
          models={models.value ?? []}
          loading={models.status === "loading"}
          value={value.model}
          defaultLabel={
            modelDefault
              ? `Provider default (${modelDefault})`
              : "Provider default"
          }
          {...(models.status === "error"
            ? { description: `Could not list models: ${models.error}` }
            : {})}
          disabled={disabled}
          onChange={(model) => onChange({ ...value, model })}
        />
        {!rows && <TestConnection choice={value} disabled={disabled} />}
      </>
    );
  }

  /** The agent's provider's key, and a test that it answers. */
  function ProviderSetup({ choice }: Readonly<{ choice: Choice }>) {
    const [listing, reload] = useRead(() => setup.providers(), "providers");
    const id = choice.provider || listing.value?.defaults.provider;
    const provider = listing.value?.providers.find((item) => item.id === id);
    return (
      <>
        {listing.status === "error" && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={reload}>Try again</Button>
            <p role="alert" className="buzz-field-error m-0">
              {listing.error}
            </p>
          </div>
        )}
        {provider && (
          <ProviderKeys
            key={provider.id}
            provider={provider}
            disabled={false}
            onSaved={reload}
          />
        )}
        <TestConnection choice={choice} disabled={false} />
      </>
    );
  }

  /** Asks the provider and model for one short reply. */
  function TestConnection({
    choice,
    disabled,
  }: Readonly<{ choice: Choice; disabled: boolean }>) {
    // A result belongs to the choice it tested.
    const key = `${choice.provider}\u0000${choice.model}`;
    const [result, setResult] = useState<{
      key: string;
      tested: Tested | "testing";
    }>();
    const tested = result?.key === key ? result.tested : undefined;
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={disabled || tested === "testing"}
          loading={tested === "testing"}
          onClick={async () => {
            setResult({ key, tested: "testing" });
            setResult({ key, tested: await setup.test(choice) });
          }}
        >
          Test connection
        </Button>
        {tested && tested !== "testing" && (
          <p
            role={tested.ok ? "status" : "alert"}
            className={tested.ok ? "m-0 text-body-sm" : "buzz-field-error m-0"}
          >
            {tested.message}
          </p>
        )}
      </div>
    );
  }

  /** The thinking level turns run on: goose's default, or one goose offers
   * for the provider and model. */
  function ThinkingField({
    choice,
    value,
    onChange,
  }: Readonly<{
    choice: Choice;
    value: string;
    onChange(effort: string): void;
  }>) {
    const [efforts] = useRead(
      () => setup.efforts(choice),
      `${choice.provider}\u0000${choice.model.trim()}`,
    );
    const levels = efforts.value?.levels ?? [];
    const named = (level: string) =>
      level.charAt(0).toUpperCase() + level.slice(1);
    const fallback = efforts.value?.current
      ? named(efforts.value.current)
      : "Automatic";
    return (
      <Select
        label="Thinking"
        variant="preference"
        value={value}
        {...(!value ? { valueLabel: fallback } : {})}
        {...(efforts.status === "error"
          ? { description: `Could not read goose's levels: ${efforts.error}` }
          : {})}
        groups={[
          {
            label: "",
            options: [
              {
                value: "",
                label: `${fallback} · Default`,
              },
              // A saved level the model does not offer, or not yet read.
              ...(value && !levels.includes(value)
                ? [
                    {
                      value,
                      label:
                        efforts.status === "ready"
                          ? `${named(value)} (unavailable)`
                          : named(value),
                    },
                  ]
                : []),
              ...levels.map((level) => ({ value: level, label: named(level) })),
            ],
          },
        ]}
        onValueChange={onChange}
      />
    );
  }

  /** A provider's key and other fields, saved into goose's config. One that
   * signs in through goose is set up there. */
  function ProviderKeys({
    provider,
    disabled,
    onSaved,
  }: Readonly<{ provider: Provider; disabled: boolean; onSaved(): void }>) {
    const [saved, reread] = useRead(
      () => setup.saved(provider.id),
      provider.id,
    );
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [changing, setChanging] = useState(false);
    const entered = Object.fromEntries(
      Object.entries(draft).filter(([, text]) => text.trim()),
    );
    const ready = !disabled && !saving && Object.keys(entered).length > 0;
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await setup.save(provider.id, entered);
        setDraft({});
        setChanging(false);
        reread();
        onSaved();
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    if (provider.signsIn && !provider.configured)
      return (
        <p className="m-0 text-body-sm">
          {provider.name} signs in through goose. Run{" "}
          <code>goose configure</code> to set it up, then choose it here.
        </p>
      );
    if (provider.signsIn || !provider.keys.length) return null;
    if (provider.configured && !changing)
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-body-sm text-subtle">
            {provider.name} is set up in goose.
          </p>
          <Button disabled={disabled} onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      );
    return (
      <>
        {provider.keys.map((key) => {
          const isSet = saved.value?.has(key.name);
          return (
            <Field
              key={key.name}
              label={
                key.required
                  ? keyLabel(key.name)
                  : `${keyLabel(key.name)} (optional)`
              }
              description={
                isSet
                  ? "Saved in goose. Enter a new value to replace it."
                  : key.default
                    ? `Default: ${key.default}`
                    : key.secret
                      ? provider.steps.join(" · ") || undefined
                      : undefined
              }
            >
              <Input
                type={key.secret ? "password" : "text"}
                autoComplete="off"
                value={draft[key.name] ?? ""}
                disabled={disabled || saving}
                placeholder={isSet ? "Saved" : (key.default ?? undefined)}
                onValueChange={(text) =>
                  setDraft({ ...draft, [key.name]: text })
                }
                // Enter saves the key, not the agent settings around it.
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (ready) void submit();
                }}
              />
            </Field>
          );
        })}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={disabled || !Object.keys(entered).length}
            loading={saving}
            onClick={submit}
          >
            Save to goose
          </Button>
          {error && (
            <p role="alert" className="buzz-field-error m-0">
              {error}
            </p>
          )}
        </div>
      </>
    );
  }

  /** One session's turns, or a place's across its sessions, read on open and
   * on Refresh. A refresh keeps the last result until the new one arrives. */
  function TranscriptView({
    agent,
    row,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    row: Row;
    working?: string | undefined;
  }) {
    const workspace = readConfig(agent.config).workspace;
    const [read, setRead] = useState<
      | { status: "ready"; transcript: GooseTranscript }
      | { status: "missing" }
      | { status: "error"; error: string }
    >();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // A turn ending rereads, so its last steps show without a Refresh.
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      history
        .transcript(
          {
            agent: agent.pubkey,
            workspace,
            sessionId: row.sessionId,
            ...(row.channelId ? { place: placeOf(row.key) } : {}),
            ...(working ? { working } : {}),
          },
          abort.signal,
        )
        .then(
          (transcript) =>
            transcript
              ? ({ status: "ready", transcript } as const)
              : ({ status: "missing" } as const),
          (reason: unknown) =>
            ({ status: "error", error: message(reason) }) as const,
        )
        .then((next) => {
          if (abort.signal.aborted) return;
          setRead(next);
          setLoading(false);
        });
      return () => abort.abort();
    }, [row, workspace, working, attempt]);
    return (
      <div className="grid gap-4">
        <div>
          <Button
            type="button"
            variant="ghost"
            loading={loading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
        {!read ? (
          <p role="status" className="m-0">
            Reading the goose session…
          </p>
        ) : read.status === "missing" ? (
          <p className="m-0 text-body-sm text-subtle">
            goose has no session for this conversation on this computer. It may
            have been deleted, or it ran in a different workspace.
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the goose session: {read.error}
          </p>
        ) : (
          <ActivityTranscript
            transcript={read.transcript}
            agentName={agent.name}
            state={() => (working ? "working" : undefined)}
            before={
              read.transcript.more && (
                <p className="m-0 text-body-sm text-subtle">
                  Showing the latest {TURN_LIMIT} turns.
                </p>
              )
            }
          />
        )}
      </div>
    );
  }

  /** The agent's sessions: the one it was opened from, recent ones, and their
   * transcripts. */
  function ActivityTab({
    agent,
    conversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
  }) {
    const workspace = readConfig(agent.config).workspace;
    const live = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.pubkey),
    );
    const running = live.map(
      (session): Row => ({
        key: session.key,
        sessionId: session.sessionId ?? "",
        title: "",
        ...placeOf(session.key),
      }),
    );
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(
      running.filter((row) => row.sessionId),
      conversation,
      async (place, signal) => {
        const found = await history.find(
          agent.pubkey,
          workspace,
          place,
          signal,
        );
        return (
          found && {
            ...found,
            ...place,
            key: place.root
              ? `${place.channelId}/${place.root}`
              : place.channelId,
          }
        );
      },
    );
    const [recent, reload] = useRead(() => {
      const abort = new AbortController();
      return history.recent(agent.pubkey, workspace, abort.signal);
    }, `${agent.pubkey}\u0000${workspace}`);
    const busy = (sessionId: string) =>
      live.find((session) => session.sessionId === sessionId)?.busy;
    const status = (sessionId: string) => {
      const working = busy(sessionId);
      return working === undefined ? undefined : working ? "Working" : "Idle";
    };
    const label = (row: Row) =>
      row.title
        ? titled(agent.name, row.title)
        : `${row.channelId.slice(0, 8)} · ${row.root ? `thread ${row.root.slice(0, 8)}` : "channel"}`;
    const { open, show, back } = useOpenTranscript(conversation, label);
    const rows = (recent.value ?? [])
      .filter((row) => row.sessionId !== here?.sessionId)
      .slice(0, RECENT_LIMIT)
      .map((row): Row => ({ ...row, key: row.sessionId, channelId: "" }));
    return (
      <div className="grid gap-4">
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="goose"
            session={here}
            searching={searching}
            error={lookupError}
            status={here && status(here.sessionId)}
            onView={() => here && show(here)}
          />
        )}
        <section className="grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-body">Recent sessions</h3>
            <Button
              type="button"
              variant="ghost"
              loading={recent.status === "loading"}
              onClick={reload}
            >
              Refresh
            </Button>
          </div>
          {recent.status === "error" ? (
            <p role="alert" className="buzz-field-error m-0">
              Could not list goose's sessions: {recent.error}
            </p>
          ) : rows.length ? (
            <ul className="m-0 grid list-none gap-2 p-0">
              {rows.map((row) => (
                <li
                  key={row.sessionId}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{label(row)}</span>
                    <span className="block text-body-sm text-subtle">
                      {[
                        status(row.sessionId),
                        row.at && new Date(row.at).toLocaleString(),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`View transcript: ${label(row)}`}
                    onClick={() => show(row)}
                  >
                    View transcript
                  </Button>
                </li>
              ))}
            </ul>
          ) : recent.status === "ready" ? (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation's session starts when the agent is mentioned.
            </p>
          ) : null}
        </section>
        {open && (
          <PanelSubview
            title={label(open)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView
              agent={agent}
              row={open}
              working={busy(open.sessionId) ? open.sessionId : undefined}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <AgentInstructions
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    );
  }

  /** A provider, its key and its model, chosen apart from the card. */
  function ChooseDialog({
    value,
    onChange,
    onClose,
  }: Readonly<{
    value: Choice;
    onChange(choice: Choice): void;
    onClose(): void;
  }>) {
    const [draft, setDraft] = useState<Choice>({
      provider: value.provider,
      model: value.model,
    });
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Provider and model"
        description="goose's own config is the default. Keys are saved in goose, for every agent and the goose CLI."
        actions={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="prominent" onClick={() => onChange(draft)}>
              Use
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <ProviderFields value={draft} onChange={setDraft} />
        </div>
      </Dialog>
    );
  }

  /** goose's own default or the agent's provider and model, on New agent and
   * library cards; it opens the provider dialog. */
  function CreateModel({
    config,
    onChange,
    disabled,
    modelAppearance,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const [open, setOpen] = useState(false);
    const [listing] = useRead(() => setup.providers(), "providers");
    const defaults = listing.value?.defaults;
    const named = (id: string | undefined) =>
      listing.value?.providers.find((item) => item.id === id)?.name ?? id;
    const fallback = [named(defaults?.provider), defaults?.model]
      .filter(Boolean)
      .join(" · ");
    const providerMark = providerIcon(current.provider || defaults?.provider);
    const label =
      choiceLabel(current, named) ??
      (fallback ? `goose default (${fallback})` : "goose default");
    return (
      <>
        {/* The compact select recipe ellipsizes long model names in cards. */}
        <div className="buzz-select" data-variant="compact">
          <Button
            size="sm"
            variant={modelAppearance === "subtle" ? "subtle" : "outline"}
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <span className="buzz-select-value-content">
              <span className="buzz-select-leading" aria-hidden="true">
                <GooseLogoIcon size={18} />
              </span>
              {providerMark && (
                <span className="buzz-select-leading" aria-hidden="true">
                  {providerMark}
                </span>
              )}
              <span className="buzz-select-value" title={label}>
                {label}
              </span>
            </span>
          </Button>
        </div>
        {open && (
          <ChooseDialog
            value={current}
            onClose={() => setOpen(false)}
            onChange={(choice) => {
              onChange({ ...current, ...choice });
              setOpen(false);
            }}
          />
        )}
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
        const workspace = draft.workspace.trim() || DEFAULT_CONFIG.workspace;
        if (!validWorkspace(workspace))
          throw new Error("Enter an absolute or ~/… workspace path.");
        await save({ ...draft, model: draft.model.trim(), workspace });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <form
        id={form}
        className="grid gap-4 [container-type:inline-size]"
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
            <SettingsGroup>
              {settingsHost?.typeControl?.(configChanged)}
              <ProviderFields
                rows
                value={draft}
                onChange={(choice) => setDraft({ ...draft, ...choice })}
              />
              <ThinkingField
                choice={draft}
                value={draft.effort}
                onChange={(effort) => setDraft({ ...draft, effort })}
              />
            </SettingsGroup>
            <AgentInstructions
              value={draft.instructions}
              disabled={false}
              onChange={(instructions) => setDraft({ ...draft, instructions })}
            />
          </>
        )}
        {settingsSection !== "identity" && (
          <>
            <ProviderSetup choice={draft} />
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
              variant="preference"
              value={draft.scope}
              groups={SCOPES}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  scope: value === "channel" ? "channel" : "thread",
                })
              }
            />
          </>
        )}
        <AgentSaveButton form={form} saving={saving} disabled={!changed} />
        {settingsSection !== "identity" && settingsContent}
      </form>
    );
  }

  return {
    Create,
    CreateModel,
    SettingsTab,
    ActivityTab,
  };
}
