import type { TeamSnapshot, BundleMember } from "./team-bundles";
/** Native-owned configuration and process evidence; never a relay-session capability. */
// Keep injection reachable from the generated author contract, not host construction.
import type {} from "@deepseek-ai/cordis";
import { communityRequest } from "../communities/api";
import { createAgentModels, type AgentModels, type ModelHost } from "./models";
declare module "@deepseek-ai/cordis" {
  interface Context {
    agentControl: AgentControl;
  }
}
export type AgentAction = "start" | "stop" | "restart";
export type ImportSource = "installed" | "development";
/** Native-redacted saved-versus-running difference; raw values never cross IPC. */
export type RestartChange =
  | { kind: "value"; before: unknown; after: unknown }
  | { kind: "text"; beforeChars: number | null; afterChars: number | null }
  | { kind: "masked"; before: string | null; after: string | null }
  | { kind: "added" }
  | { kind: "removed" };
export interface RestartDiffEntry {
  field: string;
  change: RestartChange;
}
export type HarnessIntegration =
  | "buzz-agent"
  | "goose"
  | "pi"
  | "codex"
  | "external";
export type AiConfiguration =
  | { mode: "default" }
  | {
      mode: "advanced";
      effort: { kind: "value"; value: string } | { kind: "unsupported" };
    };
export interface AgentView {
  id: string;
  pubkey: string;
  relayUrl: string;
  name: string;
  /** Missing preserves existing artwork; empty removes it. */
  picture?: string | null;
  systemPrompt: string;
  /** Null inherits Agent defaults; imported agents can carry their own choice. */
  sessionPolicy: "channel" | "thread" | null;
  workspace: string;
  harness: {
    /** Stable native owner; absent preserves legacy/custom harness behavior. */
    integration?: HarnessIntegration;
    command: string;
    args: string[];
    model: string;
    provider: string;
    /** Proof-backed managed selection; the current editor keeps this read-only. */
    configuration?: AiConfiguration;
    environmentKeys: string[];
    databricks?: { host: string; filter: string } | null;
  };
  revision: number;
  runningRevision: number | null;
  enabled: boolean;
  status:
    | "stopped"
    | "waiting"
    | "starting"
    | "running"
    | "stopping"
    | "failed";
  error: string | null;
  diagnostics: string[];
  profilePending?: boolean;
  /** Launch restore preference; saving it never changes the running process. */
  startOnAppLaunch: boolean;
  /** Effective response policy for the next start; null when it is invalid. */
  respondTo: "owner-only" | "allowlist" | "anyone" | null;
  /** Imported provider backend id; null for local agents. */
  backend: string | null;
  /** Redacted native effective behavior not representable by standalone snapshots. */
  snapshotExportLimitations?: string[];
  acpCommand: string | null;
  mcpCommand: string | null;
  /** Model/provider the next start uses from saved selectors or build
   * defaults. Null when none applies or an environment override decides it. */
  launchModel: string | null;
  launchProvider: string | null;
  /** Next-start listener workers, including native defaults/overrides; never a raw env value. */
  launchParallelism?: number | null;
  /** Effort level the next start applies; null when the harness decides. */
  launchEffort?: string | null;
  /** Environment key deciding that selector; its value stays native. */
  launchModelEnv: string | null;
  launchProviderEnv: string | null;
  /** Empty unless a running process was started with different saved settings. */
  restartDiff: RestartDiffEntry[];
  /** Native refuses to delete a deployed remote record. */
  deployedRemote?: boolean;
  /** Older imports need an explicit snapshot of their legacy team instructions. */
  needsTeamImport?: boolean;
  /** Absent on older hosts means an existing configured setup. */
  configured?: boolean;
}
export interface ParkedIdentity {
  pubkey: string;
  name: string;
  /** Historical metadata sources, not a credential availability assertion. */
  sources: ImportSource[];
}
export interface ControlSnapshot {
  localInventoryActions?: boolean;
  parked?: ParkedIdentity[];
  inventoryWarnings?: string[];
  agents: AgentView[];
  runtimeAvailable: boolean;
  /** Native executable presence and editing suggestions, not sign-in or execution evidence.
   * Optional so an older running native host retains editable custom values. */
  harnessOptions?: {
    id?: HarnessIntegration;
    command: string;
    label: string;
    available?: boolean;
    /** Executable presence only; Pi also needs Node.js for its adapter. */
    status?:
      | "ready"
      | "cli-needed"
      | "adapter-needed"
      | "check-needed"
      | "not-enabled";
    /** The native installer is available on macOS/Linux, not Windows. */
    installSupported?: boolean;
    /** The selected Pi install is app-owned and older than the pinned adapter. */
    updateSupported?: boolean;
    defaultArgs?: string[];
    providers: { value: string; label: string }[];
    /** Native integration policy; absent only on older hosts. */
    configurationPolicy?: HarnessConfigurationPolicy;
  }[];
  /** Settings setup/auth guidance; selectable tools are reported in harnessOptions. */
  claudeSetup?: {
    status: "ready" | "cli-needed" | "adapter-needed";
    installSupported: boolean;
    loginCommand: string | null;
  };
  /** False while native credential/import acceptance is outstanding. */
  importAvailable?: boolean;
  createAvailable?: boolean;
  avatarEditingAvailable?: boolean;
  defaultWorkspace?: string;
  runtimeMessage?: string | null;
  databricksDefaults?: { host: string; filter: string };
  agentDefaults?: { provider: string; model: string; ownerOnly: boolean };
  /** Device-wide Agent defaults from Settings; environment keys only. */
  defaultSettings?: AgentDefaultSettings;
  /** Running agents restarted by the save that produced this snapshot. */
  restarted?: number;
  /** Agents whose automatic restart after that save failed. */
  restartFailures?: number;
}
/** Static integration rules. Catalogs, credentials and applied settings are separate evidence. */
export interface HarnessConfigurationPolicy {
  authentication: "provider" | "harnessWithOverrides" | "external";
  provider: "selector" | "discovered" | "external";
  /** Legacy inheritance is distinct from managed Default. */
  supportedModes: ("default" | "advanced")[];
  model: "optional" | "withProvider";
  effortDiscovery: "unknown" | "modelSpecific";
  selectorEnvironment: { model: string; provider: string } | null;
}
export interface AgentDefaultSettings {
  harness: "buzz-agent" | "goose" | "pi";
  provider: string;
  model: string;
  effort: string;
  sessionPolicy: "channel" | "thread";
  environmentKeys: string[];
}
export interface AgentDefaultsEdit
  extends Omit<AgentDefaultSettings, "environmentKeys"> {
  /** Missing preserves the native value; null removes it; string replaces it. */
  environment: Record<string, string | null>;
}
/** Save feedback once native restarted the affected running agents. */
export function savedMessage(restarted = 0, failures = 0) {
  const agents = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
  const saved =
    restarted === 0 ? "Saved." : `Saved. Restarted ${agents(restarted)}.`;
  return failures === 0
    ? saved
    : `${saved} ${agents(failures)} couldn’t restart with the new settings; check Agents.`;
}
export interface AgentEdit {
  name: string;
  /** Omitted preserves artwork; empty removes it. */
  picture?: string;
  systemPrompt: string;
  sessionPolicy: "channel" | "thread" | null;
  workspace: string;
  harness: Omit<AgentView["harness"], "environmentKeys">;
  /** Missing preserves the native value; null removes it; string replaces it. */
  environment: Record<string, string | null>;
  /** Missing preserves the saved effort level; a value replaces it. */
  effort?: string;
}
export interface AgentImportPreview {
  token: string;
  sourcePath: string;
  candidates: (Pick<AgentView, "id" | "pubkey" | "relayUrl" | "name"> & {
    /** The imported prompt drops a team section old Buzz baked into it. */
    stripsTeamInstructions?: boolean;
  })[];
  warnings: string[];
}
export type AgentLogTarget = Pick<AgentView, "id" | "pubkey" | "relayUrl"> & {
  /** Scoped signer; never a caller-supplied identity or public key. */
  authorize(
    target: Pick<AgentView, "id" | "pubkey" | "relayUrl">,
    nonce: string,
  ): Promise<string>;
};
export interface HarnessInstallReport {
  ready: boolean;
  restarted: number;
  restartFailures: number;
  logPath: string;
  output: string;
  error: string | null;
}

export type CommunityResolution = {
  pubkey: string;
  relayUrl: string;
  owner: string;
  signature: string;
};
export type CloneSettings = Pick<AgentEdit, "name" | "systemPrompt">;
/** A community catalog definition that seeds a new agent. Portable fields
 * only: never paths, arguments, environment values or credentials. */
export type CatalogSeed = CloneSettings & {
  origin: "catalog";
  sessionPolicy: "channel" | "thread";
  runtime?: string;
  model?: string;
  provider?: string;
  /** Already-filtered HTTPS artwork from the publication. */
  picture?: string;
};
export interface AgentControlHost {
  readLog?(target: AgentLogTarget): Promise<string>;
  configureHere?(
    id: string,
    resolution: CommunityResolution,
  ): Promise<ControlSnapshot>;
  localCloneSettings?(id: string): Promise<CloneSettings>;
  cloneSettings?(source: ImportSource, pubkey: string): Promise<CloneSettings>;
  models?: ModelHost;
  installPi?(): Promise<HarnessInstallReport>;
  installClaude?(): Promise<HarnessInstallReport>;
  installCodex?(): Promise<HarnessInstallReport>;
  /** Settings-only read; does not start an agent or change credentials. */
  checkClaudeAuth?(): Promise<boolean | null>;
  checkCodexAuth?(): Promise<boolean | null>;
  prepareCreate?(
    requestId: string,
    destination: string,
    owner: string,
  ): Promise<{ id: string; pubkey: string; saved?: boolean }>;
  commitCreate?(
    requestId: string,
    edit: AgentEdit,
    auth: string,
    bundle?: BundleMember,
  ): Promise<ControlSnapshot>;
  exportTeam?(
    team: TeamSnapshot["team"],
    members: string[],
    community: string,
    memoryLevel?: "none" | "core" | "everything",
  ): Promise<TeamSnapshot>;
  /** Writes each team's current text into its members' settings, clears it
   * for agents no team with text lists, and never restarts anyone. */
  syncTeamInstructions?(
    community: string,
    teams: Record<string, string>,
  ): Promise<ControlSnapshot>;
  previewTeam?(content: string): Promise<TeamSnapshot>;
  publishProfile?(id: string): Promise<ControlSnapshot>;
  writeSnapshotMemory?(
    id: string,
    entries: readonly { slug: string; body: string }[],
  ): Promise<{ written: number; total: number; errors: string[] }>;
  setStartOnAppLaunch?(id: string, enabled: boolean): Promise<ControlSnapshot>;
  snapshot(): Promise<ControlSnapshot>;
  save(
    id: string,
    expectedRevision: number,
    edit: AgentEdit,
  ): Promise<ControlSnapshot>;
  delete?(id: string, expectedRevision: number): Promise<ControlSnapshot>;
  saveDefaults?(edit: AgentDefaultsEdit): Promise<ControlSnapshot>;
  action(
    id: string,
    action: AgentAction,
    replayFloor?: number,
  ): Promise<ControlSnapshot>;
  previewImport(
    source: ImportSource,
    destination: string,
  ): Promise<AgentImportPreview>;
  commitImport(token: string, ids: string[]): Promise<ControlSnapshot>;
}
interface HarnessInstallState {
  installing: boolean;
  report: HarnessInstallReport | null;
  error: string | null;
}
export interface AgentControlState {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  data: ControlSnapshot | null;
  busy: boolean;
  /** App-lifetime install progress and last result, independent of agent writes. */
  piInstall?: HarnessInstallState;
  claudeInstall?: HarnessInstallState;
  codexInstall?: HarnessInstallState;
  /** A credential wait may be interrupted only by explicit Stop. */
  pendingLaunch?: string | null;
  /** Accepted process actions, keyed by native ID across all control surfaces. */
  actionVersions?: Readonly<Record<string, number>>;
  pendingCredentialWrite?: boolean;
  stopping?: boolean;
  error: string | null;
}
export interface AgentControl {
  /** Sensitive local output. Native custody and exact community are rechecked per read. */
  readLog?(target: AgentLogTarget): Promise<string>;
  configureHere?: AgentControlHost["configureHere"];
  localCloneSettings?: AgentControlHost["localCloneSettings"];
  cloneSettings?: AgentControlHost["cloneSettings"];
  models?: AgentModels;
  installPi?(): Promise<HarnessInstallReport>;
  installClaude?(): Promise<HarnessInstallReport>;
  installCodex?(): Promise<HarnessInstallReport>;
  /** Settings-only read; does not start an agent or change credentials. */
  checkClaudeAuth?(): Promise<boolean | null>;
  checkCodexAuth?(): Promise<boolean | null>;
  create?(
    requestId: string,
    destination: string,
    owner: string,
    edit: AgentEdit,
    bundle?: BundleMember,
  ): Promise<AgentView>;
  exportTeam?(
    team: TeamSnapshot["team"],
    members: string[],
    community: string,
    memoryLevel?: "none" | "core" | "everything",
  ): Promise<TeamSnapshot>;
  /** Writes each team's current text into its members' settings, clears it
   * for agents no team with text lists, and never restarts anyone. */
  syncTeamInstructions?(
    community: string,
    teams: Record<string, string>,
  ): Promise<ControlSnapshot>;
  previewTeam?(content: string): Promise<TeamSnapshot>;
  publishProfile?(id: string): Promise<ControlSnapshot>;
  writeSnapshotMemory?: AgentControlHost["writeSnapshotMemory"];
  setStartOnAppLaunch?(id: string, enabled: boolean): Promise<ControlSnapshot>;
  snapshot(): AgentControlState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  save: AgentControlHost["save"];
  delete?(id: string, expectedRevision: number): Promise<ControlSnapshot>;
  saveDefaults?(edit: AgentDefaultsEdit): Promise<ControlSnapshot>;
  action: AgentControlHost["action"];
  previewImport: AgentControlHost["previewImport"];
  commitImport: AgentControlHost["commitImport"];
}

/** Shared launch availability; Stop intentionally has its own recovery policy. */
export function agentLaunchBlock(
  state: AgentControlState,
  agent: AgentView,
): string | null {
  if (agent.configured === false)
    return "Choose Use here before starting this imported identity.";
  if (state.status !== "ready") return "Refresh status before starting.";
  if (state.busy) return "Waiting for the current operation.";
  if (!state.data?.runtimeAvailable)
    return (
      state.data?.runtimeMessage || "The bundled agent runtime is unavailable."
    );
  if (agent.status === "waiting")
    return "Waiting to start; unlock Keychain if prompted.";
  if (agent.status === "starting" || agent.status === "stopping")
    return "Waiting for the process transition.";
  return null;
}

/** The host's sanitized rejection reason, if a control command carried one. */
export function agentFailureReason(problem: unknown): string {
  return problem instanceof Error && typeof problem.cause === "string"
    ? problem.cause
    : "";
}

/** Stop is recovery, not a launch: stale stopped/disabled evidence cannot veto it. */
export function canStopAgent(state: AgentControlState, id: string): boolean {
  if (
    state.busy &&
    ((!state.pendingLaunch && !state.pendingCredentialWrite) || state.stopping)
  )
    return false;
  const agent = state.data?.agents.find((candidate) => candidate.id === id);
  return (
    !!agent &&
    (state.status === "error" ||
      (state.status === "ready" &&
        (state.pendingLaunch === id ||
          agent.enabled ||
          agent.status !== "stopped")))
  );
}

export const agentControlUnavailable =
  "Local agent controls require the desktop app. This browser cannot run or manage agent processes.";

/** Own once at app composition. Disposing this projection never stops native agents. */
export function createAgentControl(
  host: AgentControlHost | null,
): AgentControl & { dispose(): void } {
  const models = createAgentModels(host?.models);
  let state: AgentControlState = {
    status: host ? "idle" : "unavailable",
    data: null,
    busy: false,
    piInstall: { installing: false, report: null, error: null },
    claudeInstall: { installing: false, report: null, error: null },
    codexInstall: { installing: false, report: null, error: null },
    error: host ? null : agentControlUnavailable,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let read: Promise<void> | null = null;
  let installNeedsRefresh = false;
  const update = (patch: Partial<AgentControlState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const ready = (data: ControlSnapshot) =>
    update({ status: "ready", data, error: null });

  function refresh(): Promise<void> {
    if (!host || disposed || state.busy) return Promise.resolve();
    if (read) return read;
    const current = generation;
    if (!state.data && state.status === "idle")
      update({ status: "loading", error: null });
    const pending = Promise.resolve()
      .then(async () => {
        // Only read-only native startup is transient. Keep the coalesced read
        // loading for up to twenty 250ms waits, not a UI error.
        for (let attempt = 0; !disposed && current === generation; attempt++) {
          try {
            return await host.snapshot();
          } catch (error) {
            if (disposed || current !== generation) return;
            if (
              attempt === 20 ||
              error !== "Agent runtime is initializing; retry shortly"
            )
              throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
          }
        }
      })
      .then(
        (data) => {
          if (data && current === generation) ready(data);
        },
        () => {
          if (current === generation)
            update({
              status: "error",
              error:
                "Could not refresh local agents. Current host status is unconfirmed.",
            });
        },
      )
      .finally(() => {
        if (read === pending) read = null;
      });
    read = pending;
    return pending;
  }

  async function refreshAfterInstall(): Promise<void> {
    if (!installNeedsRefresh || disposed || state.busy) return;
    installNeedsRefresh = false;
    // An earlier snapshot may have started before the installer completed.
    if (read) await read;
    if (state.busy) {
      installNeedsRefresh = true;
      return;
    }
    await refresh();
  }

  async function run<T>(
    operation: (host: AgentControlHost) => Promise<T>,
    apply: (result: T) => void,
    allowRecoveryStop = false,
    launchId?: string,
    credentialWrite = false,
  ): Promise<T> {
    if (!host || disposed) throw new Error(agentControlUnavailable);
    if (state.busy && !allowRecoveryStop)
      throw new Error("Another agent operation is in progress.");
    if (state.status !== "ready" && !allowRecoveryStop)
      throw new Error("Refresh local agents before trying again.");
    const current = ++generation;
    // A pre-write read must not overwrite this command, even when it completes later.
    read = null;
    update({
      busy: true,
      error: null,
      ...(launchId ? { pendingLaunch: launchId } : {}),
      ...(credentialWrite ? { pendingCredentialWrite: true } : {}),
      stopping: allowRecoveryStop,
    });
    try {
      const result = await operation(host);
      if (disposed || current !== generation)
        throw new Error("Agent controls are no longer available.");
      apply(result);
      return result;
    } catch (error) {
      // Host rejects with sanitized user-facing strings, never raw child output.
      const detail =
        typeof error === "string"
          ? `${error}${/[.!?]$/.test(error) ? "" : "."}`
          : "";
      const message = `${detail ? `${detail} ` : ""}Could not confirm the operation. Check current status and saved settings before retrying; the operation will not be repeated automatically. Your edits are retained.`;
      if (current === generation) update({ status: "error", error: message });
      // Dialogs own failed-write details after a successful status read; the
      // cause carries the host reason without its unconfirmed-status guidance.
      throw new Error(message, detail ? { cause: detail } : undefined);
    } finally {
      // A superseded credential wait still owns its busy lane, but never the
      // newer Stop's result/error. Credential writes may commit; refresh recovers them.
      if (!disposed && (launchId || credentialWrite)) {
        update({
          ...(launchId
            ? { pendingLaunch: null }
            : { pendingCredentialWrite: false }),
          busy: !!state.stopping,
        });
      } else if (current === generation) {
        update({
          stopping: false,
          busy: !!(state.pendingLaunch || state.pendingCredentialWrite),
        });
      }
      void refreshAfterInstall();
    }
  }

  const action: AgentControlHost["action"] = (id, command, replayFloor) => {
    return run(
      (native) => {
        update({
          actionVersions: { ...state.actionVersions, [id]: generation },
        });
        return native.action(
          id,
          command,
          ...(replayFloor === undefined ? [] : [replayFloor]),
        );
      },
      ready,
      command === "stop" && canStopAgent(state, id),
      command === "stop" ? undefined : id,
    );
  };
  async function installHarness(
    key: "piInstall" | "claudeInstall" | "codexInstall",
    label: string,
    execute: () => Promise<HarnessInstallReport>,
  ): Promise<HarnessInstallReport> {
    if (disposed) throw new Error(agentControlUnavailable);
    if (
      state.piInstall?.installing ||
      state.claudeInstall?.installing ||
      state.codexInstall?.installing
    )
      throw new Error("A Harness installation is already in progress.");
    if (state.status !== "ready" || state.busy)
      throw new Error(`Refresh local agents before installing ${label}.`);
    update({ [key]: { installing: true, report: null, error: null } });
    try {
      const report = await execute();
      update({ [key]: { installing: false, report, error: null } });
      return report;
    } catch {
      update({
        [key]: {
          installing: false,
          report: null,
          error: `Couldn’t install ${label}. Try again or check the desktop app.`,
        },
      });
      throw new Error(`Could not install ${label}.`);
    } finally {
      installNeedsRefresh = true;
      await refreshAfterInstall();
    }
  }
  const installPi = host?.installPi;
  const installClaude = host?.installClaude;
  const installCodex = host?.installCodex;
  const checkClaudeAuth = host?.checkClaudeAuth;
  const checkCodexAuth = host?.checkCodexAuth;
  const writeSnapshotMemory = host?.writeSnapshotMemory;
  return {
    models,
    ...(checkClaudeAuth ? { checkClaudeAuth } : {}),
    ...(checkCodexAuth ? { checkCodexAuth } : {}),
    ...(host?.readLog
      ? {
          readLog: async (target: AgentLogTarget) => {
            if (disposed) throw new Error(agentControlUnavailable);
            const readLog = host.readLog;
            if (!readLog) throw new Error(agentControlUnavailable);
            const content = await readLog(target);
            if (disposed) throw new Error(agentControlUnavailable);
            return content;
          },
        }
      : {}),
    ...(installPi
      ? { installPi: () => installHarness("piInstall", "Pi", installPi) }
      : {}),
    ...(installClaude
      ? {
          installClaude: () =>
            installHarness("claudeInstall", "Claude Code", installClaude),
        }
      : {}),
    ...(installCodex
      ? {
          installCodex: () =>
            installHarness(
              "codexInstall",
              "the Codex ACP adapter",
              installCodex,
            ),
        }
      : {}),
    ...(host?.prepareCreate && host.commitCreate
      ? {
          create: async (
            requestId: string,
            destination: string,
            owner: string,
            edit: AgentEdit,
            bundle?: BundleMember,
          ) => {
            let id = "";
            const data = await run(
              async (native) => {
                if (!native.prepareCreate || !native.commitCreate)
                  throw new Error("Agent creation is unavailable.");
                const prepared = await native.prepareCreate(
                  requestId,
                  destination,
                  owner,
                );
                id = prepared.id;
                if (prepared.saved) return native.snapshot();
                const result = await communityRequest<{ auth: string[] }>(
                  destination,
                  "authorize-agent",
                  { pubkey: prepared.pubkey, owner },
                );
                return native.commitCreate(
                  requestId,
                  edit,
                  JSON.stringify(result.auth),
                  bundle,
                );
              },
              ready,
              false,
              undefined,
              true,
            );
            const agent = data.agents.find((agent) => agent.id === id);
            if (!agent)
              throw new Error(
                "Creation was not confirmed; refresh agents before trying again.",
              );
            return agent;
          },
        }
      : {}),
    ...(host?.syncTeamInstructions
      ? {
          syncTeamInstructions: (
            community: string,
            teams: Record<string, string>,
          ) =>
            run(async (host) => {
              if (!host.syncTeamInstructions)
                throw new Error("Team instruction updates are unavailable.");
              return host.syncTeamInstructions(community, teams);
            }, ready),
        }
      : {}),
    ...(host?.exportTeam
      ? {
          exportTeam: (
            team: TeamSnapshot["team"],
            members: string[],
            community: string,
            memoryLevel: "none" | "core" | "everything" = "none",
          ) => {
            if (!host.exportTeam)
              throw new Error("Team export is unavailable.");
            return host.exportTeam(team, members, community, memoryLevel);
          },
        }
      : {}),
    ...(host?.previewTeam
      ? {
          previewTeam: (content: string) => {
            if (!host.previewTeam)
              throw new Error("Team preview is unavailable.");
            return host.previewTeam(content);
          },
        }
      : {}),
    ...(host?.publishProfile
      ? {
          publishProfile: (id: string) =>
            run(
              (native) => {
                if (!native.publishProfile)
                  throw new Error("Profile publication is unavailable.");
                return native.publishProfile(id);
              },
              ready,
              false,
              undefined,
              true,
            ),
        }
      : {}),
    ...(writeSnapshotMemory
      ? {
          writeSnapshotMemory: (
            id: string,
            entries: readonly { slug: string; body: string }[],
          ) =>
            run(
              () => writeSnapshotMemory(id, entries),
              () => {
                if (state.data) ready(state.data);
              },
              false,
              undefined,
              true,
            ),
        }
      : {}),
    ...(host?.setStartOnAppLaunch
      ? {
          setStartOnAppLaunch: (id: string, enabled: boolean) =>
            run((native) => {
              if (!native.setStartOnAppLaunch)
                throw new Error("Startup preference is unavailable.");
              return native.setStartOnAppLaunch(id, enabled);
            }, ready),
        }
      : {}),
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    save: (id, revision, edit) =>
      // Existing native Save owns revision checks and restart. Inference is
      // performed only by the runtime, never as a prerequisite to persistence.
      run(
        (native) => native.save(id, revision, edit),
        ready,
        false,
        undefined,
        true,
      ),
    ...(host?.saveDefaults
      ? {
          saveDefaults: (edit: AgentDefaultsEdit) =>
            run(
              (native) => {
                if (!native.saveDefaults)
                  throw new Error("Agent defaults are unavailable.");
                return native.saveDefaults(edit);
              },
              ready,
              false,
              undefined,
              true,
            ),
        }
      : {}),
    ...(host?.delete
      ? {
          // Resolve the host method per call, like every other command.
          delete: (id: string, revision: number) =>
            run((native) => {
              if (!native.delete)
                throw new Error("Agent deletion is unavailable.");
              return native.delete(id, revision);
            }, ready),
        }
      : {}),
    action,
    ...(host?.configureHere
      ? {
          configureHere: (id: string, resolution: CommunityResolution) =>
            run(
              (native) => {
                if (!native.configureHere)
                  throw new Error("Use here is unavailable.");
                return native.configureHere(id, resolution);
              },
              (data) => update({ data }),
              false,
              undefined,
              true,
            ),
        }
      : {}),
    ...(host?.localCloneSettings
      ? {
          localCloneSettings: (id: string) =>
            run(
              (native) => {
                if (!native.localCloneSettings)
                  throw new Error("Local clone is unavailable.");
                return native.localCloneSettings(id);
              },
              () => {},
              false,
              undefined,
              true,
            ),
        }
      : {}),
    ...(host?.cloneSettings
      ? {
          cloneSettings: (source: ImportSource, pubkey: string) =>
            run(
              (native) => {
                if (!native.cloneSettings)
                  throw new Error("Clone settings are unavailable.");
                return native.cloneSettings(source, pubkey);
              },
              () => {},
            ),
        }
      : {}),
    previewImport: (source, destination) =>
      run(
        (native) => native.previewImport(source, destination),
        () => {},
      ),
    commitImport: (token, ids) =>
      run(
        (native) => native.commitImport(token, ids),
        ready,
        false,
        undefined,
        true,
      ),
    dispose() {
      disposed = true;
      models.dispose();
      generation++;
      listeners.clear();
    },
  };
}
