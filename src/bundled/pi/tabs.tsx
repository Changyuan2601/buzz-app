// Pi's New agent choices and agent settings. Providers, their keys and their
// models are Pi's own: listed from it, and keys saved with its login.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { ModelPicker } from "../../features/agents/ModelPicker";
import {
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateModelMenuProps,
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { PiLogoIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import {
  type Config,
  DEFAULT_CONFIG,
  type PiRuntime,
  type Place,
  config as readConfig,
} from "./runtime";
import type { PiModel, PiSetup, Provider, Providers, Tested } from "./setup";
import { type PiTranscript, TURN_LIMIT } from "./transcript";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One conversation per thread" },
      { value: "channel", label: "One conversation per channel" },
    ],
  },
];

type Choice = Readonly<{ provider: string; model: string }>;
const CONVERSATION_LIMIT = 30;
const label = ({ channelId, name, root }: Place) =>
  `${name ? `#${name}` : channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
type Read<T> =
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T };

/** `read()` as it settles, read again when `key` changes or on `retry`. A
 * value already shown stays while it is read again. */
function useRead<T>(read: () => Promise<T>, key: string) {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` follows `key`.
  useEffect(() => {
    let current = true;
    setState((prior) =>
      prior.value === undefined
        ? { status: "loading" }
        : { status: "loading", value: prior.value },
    );
    read().then(
      (value) => current && setState({ status: "ready", value }),
      (error: unknown) =>
        current && setState({ status: "error", error: message(error) }),
    );
    return () => {
      current = false;
    };
  }, [key, round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

/** The model Pi's settings give a choice without one: only for the provider
 * those settings name. */
const defaultModel = (
  { provider }: Choice,
  defaults: Providers["defaults"] | undefined,
) =>
  (provider || defaults?.provider) === defaults?.provider
    ? defaults?.model
    : undefined;
/** Whether a choice names no model, nor has Pi's default one, once Pi's
 * settings are known. */
const modelless = (
  choice: Choice,
  defaults: Providers["defaults"] | undefined,
) => Boolean(defaults && !choice.model && !defaultModel(choice, defaults));
/** The provider a choice runs on, once Pi's providers are known, when Buzz's
 * Pi doesn't have it: one a Pi package adds, which Buzz doesn't load. */
const unknownProvider = (choice: Choice, providers: Providers | undefined) => {
  const id = choice.provider || providers?.defaults.provider;
  return id && providers && !providers.providers.some((item) => item.id === id)
    ? id
    : undefined;
};
/** Whether a choice can't run, as far as Pi's providers say. */
const unusable = (choice: Choice, providers: Providers | undefined) =>
  Boolean(unknownProvider(choice, providers)) ||
  modelless(choice, providers?.defaults);
/** `Anthropic · claude-opus-5-5`, or undefined for Pi's own default. */
const choiceLabel = (
  { provider, model }: Choice,
  named: (id: string) => string | undefined = (id) => id,
) =>
  [provider && named(provider), model].filter(Boolean).join(" · ") || undefined;

export function createTabs({
  setup,
  runtime,
}: Readonly<{
  setup: PiSetup;
  runtime: Pick<PiRuntime, "places" | "working" | "transcript" | "subscribe">;
}>) {
  /** The provider, its key and its model, and a test that they answer. */
  function ProviderFields({
    value,
    onChange,
    disabled = false,
  }: Readonly<{
    value: Choice;
    onChange(value: Choice): void;
    disabled?: boolean;
  }>) {
    const [listing, reload] = useRead(() => setup.providers(), "providers");
    const providers = listing.value;
    const fallback = providers?.defaults.provider;
    const id = value.provider || fallback || "";
    const provider = providers?.providers.find((item) => item.id === id);
    const [models] = useRead(
      () => (id ? setup.models(id) : Promise.resolve([] as PiModel[])),
      id,
    );
    // A result belongs to the choice it tested.
    const choice = `${value.provider}\u0000${value.model}`;
    const [result, setResult] = useState<{
      choice: string;
      tested: Tested | "testing";
    }>();
    const tested = result?.choice === choice ? result.tested : undefined;
    const named = (key: string | undefined) =>
      providers?.providers.find((item) => item.id === key)?.name ?? key;
    const modelDefault = defaultModel(value, providers?.defaults);
    const missing = modelless(value, providers?.defaults);
    const unknown = unknownProvider(value, providers);
    return (
      <>
        <Select
          label="Model provider"
          variant="field"
          value={value.provider}
          disabled={disabled || !providers}
          {...(listing.status === "error"
            ? { error: listing.error }
            : unknown
              ? {
                  error: `Buzz can use only Pi's built-in providers, and ${unknown} isn't one. It may come from a Pi package. Choose another.`,
                }
              : listing.status === "loading" && !providers
                ? { description: "Loading Pi's providers…" }
                : !id
                  ? {
                      description:
                        "Pi's settings name no provider. Choose one.",
                    }
                  : {})}
          groups={[
            {
              label: "",
              options: [
                {
                  value: "",
                  label: fallback
                    ? `From Pi settings (${named(fallback)})`
                    : "From Pi settings",
                },
                ...(providers?.providers ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                  ...(item.configured ? { description: "Set up" } : {}),
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
        {provider && (
          <ProviderKey
            key={provider.id}
            provider={provider}
            disabled={disabled}
            onSaved={reload}
          />
        )}
        <ModelPicker
          allowCustomModel={false}
          models={models.value ?? []}
          loading={models.status === "loading"}
          value={value.model}
          defaultLabel={
            modelDefault ? `Pi default (${modelDefault})` : "Pi default"
          }
          {...(models.status === "error"
            ? { description: `Could not list models: ${models.error}` }
            : missing && id && !unknown
              ? {
                  description: `Pi's settings name no model for ${named(id)}. Choose one.`,
                }
              : {})}
          disabled={disabled || Boolean(unknown)}
          onChange={(model) => onChange({ ...value, model })}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={
              disabled || unusable(value, providers) || tested === "testing"
            }
            loading={tested === "testing"}
            onClick={async () => {
              setResult({ choice, tested: "testing" });
              setResult({
                choice,
                tested: await setup.test(value).catch((error: unknown) => ({
                  ok: false,
                  message: message(error),
                })),
              });
            }}
          >
            Test connection
          </Button>
          {tested && tested !== "testing" && (
            <p
              role={tested.ok ? "status" : "alert"}
              className={
                tested.ok ? "m-0 text-body-sm" : "buzz-field-error m-0"
              }
            >
              {tested.message}
            </p>
          )}
        </div>
      </>
    );
  }

  /** A provider's API key, saved with Pi's login. One that signs in without
   * a key is set up with the `pi` command. */
  function ProviderKey({
    provider,
    disabled,
    onSaved,
  }: Readonly<{ provider: Provider; disabled: boolean; onSaved(): void }>) {
    const [key, setKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [changing, setChanging] = useState(false);
    if (provider.configured && (!provider.key || !changing))
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-body-sm text-subtle">
            {provider.name} is set up in Pi.
          </p>
          {provider.key && (
            <Button disabled={disabled} onClick={() => setChanging(true)}>
              Change
            </Button>
          )}
        </div>
      );
    if (!provider.key)
      return (
        <p className="m-0 text-body-sm">
          {provider.name} signs in through Pi. Run <code>pi</code>, then{" "}
          <code>/login</code>, to set it up, then choose it here.
        </p>
      );
    return (
      <>
        <Field
          label="API key"
          description={`Saved in ~/.pi/agent/auth.json, for every Pi agent and the pi command.${provider.signsIn ? " Or sign in with the pi command's /login." : ""}`}
        >
          <Input
            type="password"
            autoComplete="off"
            value={key}
            disabled={disabled || saving}
            onValueChange={setKey}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={disabled || !key.trim()}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                await setup.login(provider.id, key.trim());
                setKey("");
                setChanging(false);
                onSaved();
              } catch (reason) {
                setError(message(reason));
              } finally {
                setSaving(false);
              }
            }}
          >
            Save to Pi
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

  /** Whether New agent's provider dialog is open. The footer menu opens it
   * and closes before it shows, so Create, which stays, renders it. */
  const choosing = {
    open: false,
    listeners: new Set<() => void>(),
    set(open: boolean) {
      choosing.open = open;
      for (const listener of choosing.listeners) listener();
    },
    subscribe(listener: () => void) {
      choosing.listeners.add(listener);
      return () => {
        choosing.listeners.delete(listener);
      };
    },
  };

  /** The instructions a new agent starts with, and the provider dialog its
   * footer menu opens. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const open = useSyncExternalStore(choosing.subscribe, () => choosing.open);
    return (
      <>
        <AgentInstructions
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...current, instructions })}
        />
        {open && (
          <ChooseDialog
            value={current}
            onClose={() => choosing.set(false)}
            onChange={(choice) => {
              onChange({ ...current, ...choice });
              choosing.set(false);
            }}
          />
        )}
      </>
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
    const [listing] = useRead(() => setup.providers(), "providers");
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Provider and model"
        description="Pi's own settings are the default. Keys are saved in Pi, for every Pi agent and the pi command."
        finalFocus={false}
        actions={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="prominent"
              disabled={unusable(draft, listing.value)}
              focusableWhenDisabled
              onClick={() => onChange(draft)}
            >
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

  /** Pi's own default and the agent's choice, in New agent's type menu. */
  function CreateModelMenu({
    config,
    onChange,
    disabled,
    active = true,
  }: AgentCreateModelMenuProps<Config>) {
    const current = readConfig(config);
    const [listing] = useRead(() => setup.providers(), "providers");
    const defaults = listing.value?.defaults;
    const named = (id: string | undefined) =>
      listing.value?.providers.find((item) => item.id === id)?.name ?? id;
    const fallback = [named(defaults?.provider), defaults?.model]
      .filter(Boolean)
      .join(" · ");
    const chosen = current.provider || current.model;
    const unknown = unknownProvider({ provider: "", model: "" }, listing.value);
    const icon = <PiLogoIcon size={18} aria-hidden="true" />;
    return (
      <>
        <MenuRadioGroup
          value={active ? (chosen ? "chosen" : "default") : "\0inactive"}
          onValueChange={(item) => {
            if (item === "default")
              onChange({ ...current, provider: "", model: "" });
            else onChange(current);
          }}
        >
          <MenuRadioItem value="default" disabled={disabled} closeOnClick>
            <ChoiceRow
              label={fallback ? `Pi default (${fallback})` : "Pi default"}
              description={
                unknown
                  ? `${unknown} isn't built into Pi, so Buzz can't use it`
                  : defaults && !defaults.model
                    ? "Not set in ~/.pi/agent/settings.json"
                    : "From ~/.pi/agent/settings.json"
              }
              leading={icon}
            />
          </MenuRadioItem>
          {chosen && (
            <MenuRadioItem value="chosen" disabled={disabled} closeOnClick>
              <ChoiceRow
                label={choiceLabel(current, named) ?? ""}
                description="Chosen for this agent"
                leading={icon}
              />
            </MenuRadioItem>
          )}
        </MenuRadioGroup>
        <MenuItem
          disabled={disabled}
          closeOnClick
          onClick={() => {
            // Choosing Pi here also makes it the card's type.
            onChange(current);
            choosing.set(true);
          }}
        >
          <ChoiceRow
            label="Choose provider and model…"
            description="Set up a provider and its key, and test it"
            leading={icon}
          />
        </MenuItem>
      </>
    );
  }

  /** The trigger's detail for a provider or model chosen for this agent. */
  const createModelLabel = (saved: Config) => choiceLabel(readConfig(saved));

  /** One conversation's turns, read on open, on Refresh, and when a turn
   * there ends. A refresh keeps the last result until the new one arrives. */
  function TranscriptView({
    agent,
    place,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    place: Place;
    working: boolean;
  }) {
    const [read, setRead] = useState<
      | { status: "ready"; transcript: PiTranscript }
      | { status: "error"; error: string }
    >();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      void runtime
        .transcript(agent.pubkey, place, working, abort.signal)
        .then(
          (transcript) => ({ status: "ready", transcript }) as const,
          (reason: unknown) =>
            ({ status: "error", error: message(reason) }) as const,
        )
        .then((next) => {
          if (abort.signal.aborted) return;
          setRead(next);
          setLoading(false);
        });
      return () => abort.abort();
    }, [agent.pubkey, place, working, attempt]);
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
            Reading the Pi conversation…
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the Pi conversation: {read.error}
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

  /** The Pi conversation of the place the profile was opened from, and the
   * agent's other recent ones, each with its transcript. Pi's storage is
   * shared by every Buzz build here, so the list is the whole history. */
  function Conversations({
    agent,
    conversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
  }) {
    const working = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.working(agent.pubkey),
    );
    // Read again as turns start and end, which can add a conversation.
    const [listing, reload] = useRead(
      () => runtime.places(agent.pubkey),
      `${agent.pubkey}\u0000${working.join()}`,
    );
    const places = listing.value;
    if (!places)
      return listing.status === "error" ? (
        <div className="grid gap-2">
          <p role="alert" className="buzz-field-error m-0">
            Could not list Pi's conversations: {listing.error}
          </p>
          <div>
            <Button type="button" onClick={reload}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <p role="status" className="m-0 text-body-sm text-subtle">
          Reading Pi's conversations…
        </p>
      );
    return (
      <PlaceList
        agent={agent}
        conversation={conversation}
        places={places}
        working={working}
      />
    );
  }

  function PlaceList({
    agent,
    conversation,
    places,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
    places: readonly Place[];
    working: readonly number[];
  }) {
    const { session: here } = useOpenedSession(
      places,
      conversation,
      async () => undefined,
    );
    const status = (place: Place) =>
      working.includes(place.conversation) ? "Working" : undefined;
    const { open, show, back } = useOpenTranscript(conversation, label);
    const recent = places
      .filter((place) => place.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    return (
      <div className="grid gap-4">
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="Pi"
            session={here}
            status={here && status(here)}
            onView={() => here && show(here)}
          />
        )}
        <section className="grid gap-1">
          <h3 className="m-0 text-body">Recent conversations</h3>
          {recent.length ? (
            <ul className="m-0 grid list-none gap-2 p-0">
              {recent.map((place) => (
                <li
                  key={place.key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{label(place)}</span>
                    <span className="block text-body-sm text-subtle">
                      {[status(place), new Date(place.at).toLocaleString()]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => show(place)}
                  >
                    View transcript
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation starts when the agent is mentioned.
            </p>
          )}
        </section>
        {open && (
          <PanelSubview
            title={label(open)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView
              agent={agent}
              place={open}
              working={working.includes(open.conversation)}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  function SettingsTab({
    agent,
    save,
    settingsHost,
    conversation,
  }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [listing] = useRead(() => setup.providers(), "providers");
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
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
        <ProviderFields
          value={draft}
          onChange={(choice) => setDraft({ ...draft, ...choice })}
        />
        <Field
          label="Workspace"
          description="The folder Pi works in. Use ~/ for your home folder."
        >
          <Input
            value={draft.workspace}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <Select
          label="Conversations"
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
          description="Added to every conversation's system prompt, after Buzz's own."
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
            disabled={!changed || unusable(draft, listing.value)}
            focusableWhenDisabled
          >
            Save
          </Button>
        </div>
        <details className="grid gap-2">
          <summary>Runtime diagnostics</summary>
          <div className="mt-2">
            <Conversations agent={agent} conversation={conversation} />
          </div>
        </details>
      </form>
    );
  }

  return { Create, CreateModelMenu, createModelLabel, SettingsTab };
}
