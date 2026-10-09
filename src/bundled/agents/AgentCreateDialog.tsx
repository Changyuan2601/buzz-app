import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  agentFailureReason,
  type AgentControl,
  type AgentControlState,
  type CatalogSeed,
  type CloneSettings,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { PlusIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import type { RelaySession } from "../../features/relay/session";
import type { AgentPublication } from "../../features/agents/catalog-protocol";
import {
  unsupportedTransport,
  unsupportedTransportMessage,
} from "../../features/agents/catalog-protocol";
import {
  AgentCatalogPreview,
  catalogAlreadyAdded,
  catalogSeed,
  rememberAdded,
} from "./CommunityCatalog";
import { AgentSettingsFields } from "./AgentSettingsFields";
import {
  agentDraft,
  agentEdit,
  harnessKind,
  type AgentDraft,
} from "./agent-edit";
import { harnessPreset } from "../../features/agents/harness-presets";

/** The Agent defaults harness is copied at creation; the rest is inherited at start. */
function newAgentDraft(state: AgentControlState): AgentDraft {
  const defaults = state.data?.defaultSettings;
  const chosen = state.data?.harnessOptions?.find(
    (option) =>
      option.available !== false &&
      harnessKind(option.command) === (defaults?.harness ?? "buzz-agent"),
  );
  const command = chosen?.command ?? "buzz-agent";
  const inherits = defaults?.harness === "buzz-agent" && !!defaults.provider;
  return {
    revision: 0,
    name: "",
    systemPrompt: "",
    sessionPolicy: null,
    workspace: state.data?.defaultWorkspace ?? "",
    command,
    args: JSON.stringify(chosen?.defaultArgs ?? []),
    model: "",
    provider:
      command !== "buzz-agent" ||
      inherits ||
      state.data?.agentDefaults?.provider
        ? ""
        : (chosen?.providers[0]?.value ?? "databricks_v2"),
    environment: {},
  };
}

/** Seeds the create form. A catalog runtime applies only when this computer
 * offers it; its model and provider travel with that runtime alone. A preset
 * harness owns its model and credentials, so it is selected with neither. */
export function seededDraft(
  state: AgentControlState,
  seed?: CloneSettings | CatalogSeed,
): AgentDraft {
  const draft = {
    ...newAgentDraft(state),
    name: seed?.name ?? "",
    systemPrompt: seed?.systemPrompt ?? "",
  };
  if (!seed || !("origin" in seed)) return draft;
  const chosen =
    seed.runtime &&
    state.data?.harnessOptions?.find(
      (option) =>
        option.available !== false &&
        harnessKind(option.command) === seed.runtime,
    );
  const seeded = {
    ...draft,
    sessionPolicy: seed.sessionPolicy,
    ...(seed.picture ? { picture: seed.picture } : {}),
  };
  if (!chosen) return seeded;
  const runtime = {
    ...seeded,
    command: chosen.command,
    args: JSON.stringify(chosen.defaultArgs ?? []),
  };
  if (harnessPreset(chosen.command))
    return { ...runtime, model: "", provider: "" };
  return {
    ...runtime,
    model: seed.model ?? "",
    provider:
      seed.provider ?? (chosen.command === draft.command ? draft.provider : ""),
  };
}

type CreatePhase = "creating" | "starting" | "publishing" | "checking";

export function AgentCreateDialog({
  control,
  state,
  destination,
  owner,
  source,
  initialSettings,
  sharedCompute = false,
  preset,
  onClose,
  onCreated,
  onOpenHarnesses,
  onImport,
  catalogSession,
}: {
  control: AgentControl;
  onOpenHarnesses?: (() => void) | undefined;
  onImport?: (() => void) | undefined;
  catalogSession?: RelaySession | undefined;
  state: AgentControlState;
  destination: string;
  owner: string;
  source?: AgentView;
  initialSettings?: CloneSettings | CatalogSeed | undefined;
  sharedCompute?: boolean;
  /** Prefilled name and instructions; the owner still reviews before creating. */
  preset?: { name: string; systemPrompt: string } | undefined;

  onClose(): void;
  /** The new identity exists, even if starting or profile setup fails later. */
  onCreated?: ((agent: AgentView) => void) | undefined;
}) {
  const catalog = catalogSession?.communityCatalog;
  const catalogAvailable =
    !!catalog?.available() && !source && !initialSettings;
  useEffect(() => {
    if (catalogAvailable) return catalog?.retain();
  }, [catalog, catalogAvailable]);
  const catalogEntries = useSyncExternalStore(
    catalog?.subscribe ?? emptySubscribe,
    catalog?.snapshot ?? emptyCatalogSnapshot,
    catalog?.snapshot ?? emptyCatalogSnapshot,
  );
  const [selectedCoordinate, setSelectedCoordinate] = useState<string>();
  const selectedPublication = catalogEntries.agents.find(
    (entry) => `${entry.owner}:${entry.d}` === selectedCoordinate,
  );
  const alreadyAdded =
    !!selectedPublication &&
    !!catalogSession &&
    catalogAlreadyAdded(
      catalogSession,
      selectedPublication,
      (id) =>
        !!control.snapshot().data?.agents.some((agent) => agent.id === id),
    );
  const transport =
    selectedPublication && unsupportedTransport(selectedPublication);
  const [requestId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<AgentDraft>(() => {
    const initial = source
      ? {
          ...agentDraft(source),
          name: `${source.name} copy`,
        }
      : seededDraft(state, initialSettings);
    return {
      ...initial,
      ...(preset
        ? { name: preset.name, systemPrompt: preset.systemPrompt }
        : {}),
      ...(sharedCompute
        ? {
            name: preset?.name ?? "Community agent",
            command: "buzz-agent",
            args: "[]",
            provider: "relay-mesh",
            model: "auto",
          }
        : {}),
      environment: { BUZZ_ACP_AGENTS: "10" },
    };
  });
  // Catalog seeds carry more than the clone notice describes.
  const cloned = !!initialSettings && !("origin" in initialSettings);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<AgentView | null>(null);
  const [nextStep, setNextStep] = useState<"start" | "profile">("start");
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<CreatePhase | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available = !!(
    destination &&
    owner &&
    state.data?.createAvailable &&
    control.create
  );
  const runtimeBlocked =
    !state.data?.runtimeAvailable && (!saved || nextStep === "start");
  const busy = phase !== null;
  const blocked = busy || state.busy || state.status !== "ready";
  const create = async (publication?: AgentPublication) => {
    if (
      blocked ||
      runtimeBlocked ||
      (publication &&
        (!catalogSession ||
          selectedPublication?.eventId !== publication.eventId ||
          alreadyAdded)) ||
      (!saved && (!available || !control.create))
    )
      return;
    setError(undefined);
    let step: "creating" | "starting" | "publishing" = "creating";
    let agent = saved;
    let startFailure: string | null = null;
    try {
      if (!agent) {
        let edit: ReturnType<typeof agentEdit>;
        try {
          edit = agentEdit(
            publication
              ? {
                  ...seededDraft(state, catalogSeed(publication.agent)),
                  environment: { BUZZ_ACP_AGENTS: "10" },
                }
              : draft,
          );
        } catch (problem) {
          if (mounted.current)
            setError(
              problem instanceof Error
                ? problem.message
                : "Check the agent settings and try again.",
            );
          return;
        }
        setPhase("creating");
        if (!control.create) return;
        agent = await control.create(requestId, destination, owner, edit);
        onCreated?.(agent);
        if (publication && catalogSession)
          rememberAdded(
            catalogSession.scope,
            catalogSession.viewer ?? "",
            publication,
            agent.id,
          );
      }
      const created = agent;
      if (!saved && mounted.current) {
        setDraft((current) => ({ ...current, environment: {} }));
        setSaved(agent);
      }

      if (!saved || nextStep === "start") {
        const current = control
          .snapshot()
          .data?.agents.find((item) => item.id === created.id);
        if (current?.status !== "running") {
          step = "starting";
          if (mounted.current) setPhase(step);
          const result = await control.action(created.id, "start");
          const started = result.agents.find((item) => item.id === created.id);
          if (started?.status !== "running") {
            startFailure = `${created.name} was created, but couldn't start. ${started?.error ?? "Check its settings, then try Start again."}`;
          }
        }
        if (!startFailure && mounted.current) setNextStep("profile");
      }

      const current = control
        .snapshot()
        .data?.agents.find((item) => item.id === created.id);
      if (current?.profilePending !== false) {
        step = "publishing";
        if (mounted.current) setPhase(step);
        if (!control.publishProfile)
          throw new Error(
            "Profile setup is unavailable. Rebuild the desktop app.",
          );
        await control.publishProfile(created.id);
      }
      if (mounted.current) {
        if (startFailure) setError(startFailure);
        else onClose();
      }
    } catch (problem) {
      if (mounted.current) setPhase("checking");
      await control.refresh();
      if (!mounted.current) return;
      const detail = agentFailureReason(problem);
      const reason = detail && ` ${detail}`;
      const refreshed = control.snapshot();
      const created = agent;
      const current = created
        ? refreshed.data?.agents.find((item) => item.id === created.id)
        : undefined;
      if (step === "starting" && current?.status === "running") {
        setNextStep("profile");
        setError(undefined);
      } else if (step === "publishing" && current?.profilePending === false) {
        if (startFailure) setError(startFailure);
        else onClose();
      } else if (step === "creating") {
        setError(
          `We couldn't confirm whether the agent was created.${reason} Check the agent list before trying again.`,
        );
      } else if (refreshed.status === "ready" && current) {
        setError(
          step === "starting"
            ? `${agent?.name ?? draft.name} was saved, but couldn't start.${reason} Check its card, then select Start agent to try again.`
            : startFailure
              ? `${startFailure} Profile setup also didn't finish.${reason}`
              : `${agent?.name ?? draft.name} was saved and started, but profile setup didn't finish.${reason} Select Finish profile to try again.`,
        );
      } else {
        setError(
          step === "starting"
            ? `${agent?.name ?? draft.name} was saved, but we couldn't confirm whether it started. Refresh status before trying again.`
            : `${agent?.name ?? draft.name} was saved, but we couldn't confirm its profile setup. Refresh status before trying again.`,
        );
      }
    } finally {
      if (mounted.current) setPhase(null);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !dirty && !blocked) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-buzz-ui="" className="buzz-dialog-backdrop" />
        <Dialog.Popup
          aria-modal="true"
          data-buzz-ui=""
          className="buzz-dialog agent-dialog text-body"
        >
          <header className="buzz-dialog-header">
            <Dialog.Title className="text-heading">
              {source
                ? `Duplicate ${source.name}`
                : cloned
                  ? "Clone agent"
                  : "Add agent"}
            </Dialog.Title>
          </header>
          <Dialog.Description className="buzz-dialog-description">
            Create and start an agent in{" "}
            {destination || "a connected community"}. It won't join a channel
            automatically.
          </Dialog.Description>
          {cloned && (
            <p className="text-body-sm text-secondary">
              Only the name and instructions were copied. Review them for
              embedded secrets. Choose this computer’s workspace and runtime
              settings. Identity keys, environment values, history and community
              membership are not copied. The source stays unchanged.
            </p>
          )}
          <div
            className={
              onImport || catalogAvailable ? "agent-add-layout" : undefined
            }
          >
            {(onImport || catalogAvailable) && (
              <nav aria-label="Add agent" className="agent-add-sidebar">
                <NavigationItem
                  label="Create agent"
                  aria-label="Create new agent"
                  icon={<PlusIcon size={16} />}
                  selected={!selectedCoordinate}
                  disabled={busy || !!saved || dirty}
                  onClick={() => setSelectedCoordinate(undefined)}
                />
                {onImport && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !!saved || dirty}
                    onClick={onImport}
                  >
                    Import
                  </Button>
                )}
                {catalogAvailable && catalogEntries.agents.length > 0 && (
                  <span className="text-label text-subtle">AGENTS</span>
                )}
                {catalogAvailable &&
                  catalogEntries.agents.map((publication) => (
                    <NavigationItem
                      key={publication.eventId}
                      label={publication.agent.displayName}
                      icon={
                        <Avatar
                          size="small"
                          src={avatarMedia(
                            publication.agent.avatarUrl,
                            catalogSession?.media,
                          )}
                          alt=""
                          fallback={publication.agent.displayName}
                        />
                      }
                      selected={
                        selectedCoordinate ===
                        `${publication.owner}:${publication.d}`
                      }
                      disabled={busy || !!saved || dirty}
                      onClick={() =>
                        setSelectedCoordinate(
                          `${publication.owner}:${publication.d}`,
                        )
                      }
                    />
                  ))}
                {catalogAvailable && catalogEntries.status === "error" && (
                  <p role="alert">{catalogEntries.error}</p>
                )}
              </nav>
            )}
            {selectedCoordinate && catalogSession ? (
              <section
                className="agent-catalog-preview"
                aria-label={
                  selectedPublication?.agent.displayName ?? "Withdrawn agent"
                }
              >
                {selectedPublication ? (
                  <AgentCatalogPreview
                    publication={selectedPublication}
                    session={catalogSession}
                  />
                ) : (
                  <p role="status">
                    This agent is no longer shared. Select another agent.
                  </p>
                )}
                {transport && (
                  <p role="note">
                    {unsupportedTransportMessage(
                      selectedPublication.agent.displayName,
                      transport,
                    )}
                  </p>
                )}
                {error && <p role="alert">{error}</p>}
                {busy && <p role="status">Adding agent…</p>}
                <Button
                  variant="primary"
                  disabled={
                    !selectedPublication ||
                    alreadyAdded ||
                    !!transport ||
                    !available ||
                    blocked ||
                    runtimeBlocked ||
                    !!saved
                  }
                  onClick={() => {
                    if (selectedPublication) void create(selectedPublication);
                  }}
                >
                  {alreadyAdded ? "Added to My Agents" : "Add agent"}
                </Button>
                <div className="buzz-dialog-actions">
                  {state.status === "error" && !busy && (
                    <Button onClick={() => void control.refresh()}>
                      Retry status
                    </Button>
                  )}
                  <Button onClick={onClose}>Close</Button>
                  {saved && (
                    <Button
                      variant="primary"
                      disabled={blocked || runtimeBlocked}
                      onClick={() => void create()}
                    >
                      {busy
                        ? phase === "starting"
                          ? "Starting…"
                          : phase === "publishing"
                            ? "Finishing…"
                            : "Checking…"
                        : nextStep === "start"
                          ? "Start agent"
                          : "Finish profile"}
                    </Button>
                  )}
                </div>
              </section>
            ) : (
              <form
                className="buzz-dialog-body space-y-section-gap"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
              >
                <AgentSettingsFields
                  draft={draft}
                  control={control}
                  state={state}
                  disabled={blocked || !!saved}
                  onOpenHarnesses={onOpenHarnesses}
                  discardEdits={dirty}
                  onChange={(patch) => {
                    setDraft({ ...draft, ...patch });
                    setDirty(true);
                    setError(undefined);
                  }}
                />
                {source?.harness.environmentKeys.length ? (
                  <p role="status" className="text-body-sm text-secondary">
                    Re-enter environment values for{" "}
                    {source.harness.environmentKeys.join(", ")}. Saved values
                    cannot be copied into a new identity.
                  </p>
                ) : null}
                {!available && (
                  <p role="status">
                    Connect to a community and use a rebuilt desktop app to
                    create an agent.
                  </p>
                )}
                {runtimeBlocked && (
                  <p role="alert">
                    This app’s agent runtime is unavailable. Repair or rebuild
                    the desktop app before {saved ? "starting" : "creating"} an
                    agent.
                    {state.data?.runtimeMessage &&
                      ` ${state.data.runtimeMessage}`}
                  </p>
                )}
                {busy && (
                  <p role="status">
                    {phase === "creating" && "Creating agent…"}
                    {phase === "starting" &&
                      `${saved?.name ?? draft.name} was created. Starting it…`}
                    {phase === "publishing" &&
                      `${saved?.name ?? draft.name} was saved. Finishing its profile…`}
                    {phase === "checking" && "Checking agent status…"}
                  </p>
                )}
                {saved && !busy && !error && (
                  <p role="status">
                    {nextStep === "start"
                      ? `${saved.name} was saved. Start it to finish setup.`
                      : `${saved.name} was saved and started. Finish its profile setup.`}
                  </p>
                )}
                {error && <p role="alert">{error}</p>}
                {state.status === "error" && !busy && (
                  <Button onClick={() => void control.refresh()}>
                    Retry status
                  </Button>
                )}
                <div className="buzz-dialog-actions">
                  <Button onClick={onClose}>
                    {busy || saved ? "Close" : "Cancel"}
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      blocked || runtimeBlocked || (!saved && !available)
                    }
                  >
                    {busy
                      ? phase === "starting"
                        ? "Starting…"
                        : phase === "publishing"
                          ? "Finishing…"
                          : phase === "checking"
                            ? "Checking…"
                            : "Creating…"
                      : saved
                        ? nextStep === "start"
                          ? "Start agent"
                          : "Finish profile"
                        : cloned
                          ? "Clone agent"
                          : "Create agent"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const emptySubscribe = () => () => {};
const emptyCatalog = { status: "unavailable" as const, agents: [], teams: [] };
const emptyCatalogSnapshot = () => emptyCatalog;
