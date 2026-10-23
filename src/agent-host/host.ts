// A standalone agent host: runs one of the agents the desktop app saved on
// this machine, with the same runner and agent type code the app runs, while
// the app does not run it. The app's own claim protocol decides which copy
// runs the agent, so opening the installed app takes it over, and quitting
// the app lets this host take it back.
import claudeManifest from "../bundled/claude-code/manifest.json";
import { claudeRun } from "../bundled/claude-code/run";
import { withScript as claudeScript } from "../bundled/claude-code/setup";
import {
  readDefaults as claudeSaved,
  resolveConfig as claudeConfig,
} from "../bundled/claude-code/defaults";
import { ClaudeRuntime, DEFAULT_CONFIG } from "../bundled/claude-code/runtime";
import { defaults as codexDefaults } from "../bundled/codex/config";
import {
  readDefaults as codexSaved,
  resolveConfig as codexConfig,
} from "../bundled/codex/defaults";
import codexManifest from "../bundled/codex/manifest.json";
import { codexRun } from "../bundled/codex/run";
import { withScript as codexScript } from "../bundled/codex/setup";
import { CodexRuntime } from "../bundled/codex/runtime";
import { CoreMemoryCache } from "../features/agents/core-memory-cache";
import { createLocalAgentActivity } from "../features/agents/local-activity";
import {
  type AgentReads,
  type MemoryListing,
  ownerReads,
} from "../features/agents/reads";
import { RecordChanges } from "../features/agents/record-changes";
import { rosterDm, rosterMember } from "../features/agents/roster";
import { soloChannel } from "../features/agents/solo-chat";
import { communityDestination } from "../features/communities/destination";
import type { Checkpoint } from "../features/agents/catch-up";
import type { Interrupted } from "../features/agents/interrupted";
import {
  type AgentIdentity,
  agentsNative,
  type NativeCall,
} from "../features/agents/native";
import { AgentRunners } from "../features/agents/runner";
import {
  type Agent,
  type RegisteredAgentType,
  teamPrompt,
} from "../features/agents/service";
import {
  type AgentRecord,
  type AgentStore,
  readOne,
  readTeams,
  recordKey,
  setAttention,
  writeRecord,
} from "../features/agents/store";
import { fileStore, nativeFiles } from "../features/agents/state";
import { relayPartition } from "../features/relay/partition";
import { type AgentSession, connectAgentSession } from "./session";
import { type Declared, processHost } from "./spawn";

/** How often due timers are looked for, as in the app. */
const TICK_MS = 5_000;

/** An agent's `core` memory, as `Agents.core` gives it. */
type Core = (
  pubkey: string,
  signal?: AbortSignal,
) => Promise<string | null | undefined>;

type TypeRun = Readonly<{
  type: RegisteredAgentType;
  sync(agents: readonly Agent[]): void;
  /** Settles once every process the type started has exited. */
  dispose(): Promise<void>;
}>;

export type HostOptions = Readonly<{
  identity: AgentIdentity;
  /** The app's custody of the agent (`custody.ts`): its key, the agents the
   * app saved, the hosting locks, and the agent storage the app shares. */
  call: NativeCall;
  log(message: string): void;
  /** Called once the agent is deleted, erased or changed in the app: this
   * host has stopped hosting it, and must stop. */
  onGone(reason: string): void;
}>;

/** Agent storage as the app keeps it, read again at each check, since the app
 * may save while this host runs. A read that a write of this host's own
 * overlaps is dropped, so it cannot put back what the write replaced. */
async function agentFiles(call: NativeCall) {
  const files = nativeFiles(call);
  const items = new Map(Object.entries(await files.load()));
  const store = fileStore(items, files.set, files.add);
  let writes = 0;
  let pending = 0;
  const counted = <T>(write: Promise<T>) => {
    writes++;
    pending++;
    return write.finally(() => pending--);
  };
  const storage: AgentStore = Object.freeze({
    ...store,
    set: (key: string, value: string | null) => counted(store.set(key, value)),
    add: (key: string, value: string) => counted(store.add(key, value)),
  });
  const reload = async () => {
    const before = writes;
    if (pending) return;
    const saved = await files.load();
    if (pending || writes !== before) return;
    items.clear();
    for (const [key, value] of Object.entries(saved)) items.set(key, value);
  };
  return { storage, reload };
}

/** Why this host must stop running `identity`, by the agents the app saved
 * here now: it was deleted, an erase removed it, or the app changed it. */
export function changed(
  identity: AgentIdentity,
  saved: readonly AgentIdentity[],
): string | undefined {
  const now = saved.find((agent) => agent.pubkey === identity.pubkey);
  if (!now || now.deleted || now.deleting)
    return "The agent is no longer saved on this machine";
  for (const field of ["type", "owner", "relay"] as const)
    if (now[field] !== identity[field])
      return `The agent's ${field} changed on this machine`;
  return undefined;
}

/** Connects as the agent, then runs it until the returned stop is called. */
export async function host(options: HostOptions): Promise<() => Promise<void>> {
  const { identity, call, log, onGone } = options;
  const { pubkey } = identity;
  const native = agentsNative(call);
  // The app's agent storage: the agent's settings, teams and sessions are the
  // ones the app shows and saves.
  const files = await agentFiles(call);
  const { storage } = files;
  // As the app scopes the agent's community, so saved sessions match.
  const scope = relayPartition(
    communityDestination(identity.relay).url,
    identity.owner,
  );
  // The app's own relay session, as the agent: it hears the agent's channels
  // and answers its reads, as the owner's session does in the app.
  // Its live connection reconnects by itself; only the first connection,
  // which reads the community's information, is tried again here.
  let connected: AgentSession | undefined;
  for (let attempt = 0; !connected; attempt++)
    try {
      connected = await connectAgentSession({
        relay: identity.relay,
        pubkey,
        call,
        scope,
      });
    } catch (error) {
      const wait = Math.min(30_000, 1_000 * 2 ** attempt);
      log(
        `Could not connect (${String(error)}); trying again in ${wait / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  const connection = connected;
  const { session } = connection;
  const reads: AgentReads = {
    ...(ownerReads(connection.relay, pubkey) as AgentReads),
    // Memory is encrypted to the owner; the app's custody reads it as the
    // agent, with the agent's key, as the owner's session reads it in the app.
    memoryListing: async (signal, slug) => {
      signal.throwIfAborted();
      const listing = await call<MemoryListing>("app_agent_memories", {
        pubkey,
        slug,
      });
      signal.throwIfAborted();
      return listing;
    },
    // The channel's Solo label decides, as for every member and agent.
    soloChat: async (_owner, channel, signal) => {
      signal.throwIfAborted();
      return soloChannel(session, channel);
    },
  };
  let live = false;
  const readsOf = (agent: string) =>
    live && agent === pubkey ? reads : undefined;

  // The agent's core memory, read through its own reads, as the app keeps it.
  const coreMemory = new CoreMemoryCache(readsOf);
  const core: Core = (agent, signal) => coreMemory.core(agent, signal);

  const [pluginId = "", typeId = ""] = identity.type.split("/");
  const run = typeRun(typeId, pluginId, identity.type, readsOf, core, storage);
  const activity = createLocalAgentActivity();

  // The agent's record as last read, and the stored text it was read from:
  // the app may save a change at any time, and each tick reads it again.
  let saved = storage.get(recordKey(pubkey));
  let stored = readOne(storage, pubkey);
  let view: Agent | undefined;
  const recordOf = (): AgentRecord => {
    if (!stored) {
      const made = run.type.defaults();
      let record: AgentRecord = {
        pubkey,
        attention: {},
        config: made.config,
      };
      for (const [slug, value] of Object.entries(made.attention ?? {}))
        record = setAttention(record, slug, value);
      stored = record;
    }
    return stored;
  };
  const reread = () => {
    const now = storage.get(recordKey(pubkey));
    if (now === saved) return;
    saved = now;
    stored = readOne(storage, pubkey);
    view = undefined;
    run.sync([agentView()]);
  };
  // One object while nothing changes: the runner compares it to see edits.
  const agent = (): Agent => {
    if (view) return view;
    const record = recordOf();
    view = Object.freeze({
      pubkey,
      name: identity.name,
      type: identity.type,
      owner: identity.owner,
      relay: identity.relay,
      place: "here",
      attention: record.attention,
      skipped: record.skipped ?? {},
      timers: record.timers ?? {},
      attentionEnabled: record.attentionEnabled === true,
      config: record.config,
    });
    return view;
  };
  /** Shows the agent's newest record to its runner. */
  const show = () => {
    view = undefined;
    run.sync([agentView()]);
  };
  // As the app's agents service: the record's changes run in order, each
  // from the record the one before it kept, and its timers wait for them.
  const changes = new RecordChanges({
    saved: (agent) => (agent === pubkey ? recordOf() : undefined),
    commit: async (agent, _, next) => {
      mine(agent);
      if (!next) throw new Error("This host cannot remove its agent");
      await writeRecord(storage, next);
      saved = storage.get(recordKey(pubkey));
      stored = next;
    },
    keep: (agent, next) => {
      mine(agent);
      stored = next;
    },
    changed: show,
    settled: () => runners.wake(pubkey),
  });
  // Whether the app deleted, erased or changed the agent: then this host
  // stops, and tells its caller why.
  let gone = false;
  // Every agent the app saved here, named in team instructions.
  let names: readonly AgentIdentity[] = [];
  const isGone = async () => {
    let reason: string | undefined;
    try {
      names = await native.list();
      reason = changed(identity, names);
    } catch (error) {
      log(`Could not read the saved agent: ${String(error)}`);
    }
    if (reason && !gone) {
      gone = true;
      // After this function has set the host up, if it is still doing so.
      queueMicrotask(() => void stop().finally(() => onGone(reason)));
    }
    return gone;
  };
  const mine = (agent: string) => {
    if (agent !== pubkey) throw new Error("Not this host's agent");
  };
  const started = Math.floor(Date.now() / 1000);
  // Catch-up progress, kept only while this host runs. This host does not
  // catch up yet, so it neither reads nor writes the agent's saved progress
  // (its own key in agent storage): as before catch-up, it hears what happens
  // while it is connected.
  let checkpoints: Readonly<Record<string, Checkpoint>> = {};
  let interrupted: Interrupted = {};
  const runners = new AgentRunners({
    ready: (agent) => (live && agent === pubkey ? agentView() : undefined),
    agent: (agent) => (agent === pubkey ? agentView() : undefined),
    member: (_, event) => rosterMember(session, pubkey, event),
    dm: (_, event) => rosterDm(session, pubkey, event),
    // No catch-up: see `checkpoints`.
    community: () => undefined,
    records: () => [recordOf()],
    checkpoints: {
      read: () => checkpoints,
      write: (next) => {
        checkpoints = next;
      },
    },
    // Turns cut off by a stop, kept as checkpoints are: this host does not
    // resume them when it starts again.
    interrupted: {
      read: () => interrupted,
      write: (agent, turns) => {
        interrupted = { ...interrupted, [agent]: turns };
      },
      changed: () => {},
    },
    scope: () => scope,
    saved: (agent) => (agent === pubkey ? stored : undefined),
    record: (agent) => {
      mine(agent);
      return recordOf();
    },
    change: async (agent, apply) => {
      mine(agent);
      const record = await changes.change(agent, (saved) =>
        apply(saved ?? recordOf()),
      );
      if (!record) throw new Error("No such agent on this host");
      return record;
    },
    changing: (agent) => changes.changing(agent),
    timers: (agent) => changes.timers(agent),
    progress: (agent, ran) => changes.progress(agent, ran),
    // Each run starts from its saved record, as the app's agents do while the
    // app binds no synced config to them: the synced copies are in the app's
    // web storage, which this host cannot read.
    start: (agent) => ({ ok: true, config: agent.config, revisions: [] }),
    team: (agent) =>
      teamPrompt(
        readTeams(storage),
        names.filter((saved) => !saved.deleted),
        agent,
      ),
    // Channel templates live in the app's web storage, which this host
    // cannot read; its agent offers none.
    templates: () => [],
    // Thread tabs are the owner's, in the app.
    tabs: () => undefined,
    // The classifier key is in the app's Keychain entry: no event watch here
    // is checked by a classifier, as in an app without one.
    classifier: () => "unavailable",
    decisions: () => undefined,
    keyStatus: () => undefined,
    classifierKey: () => "missing",
    classifierKeyGeneration: () => 0,
    setClassifierKey: () => {},
    context: async () => {
      throw new Error("This host runs no classifier");
    },
    displayName: (_, person) => reads.name(person) ?? null,
    custody: {
      claim: async (agent) => {
        mine(agent);
        // Checked here too, not only each tick, so an event cannot start a
        // turn for an agent the app has deleted.
        if (gone || (await isGone())) return false;
        try {
          return await native.claim(agent);
        } catch (error) {
          // Unlike the app, which always runs its agents, this host runs one
          // only when it knows no other copy does.
          log(`Could not check who runs the agent: ${String(error)}`);
          return false;
        }
      },
      release: native.release,
      publish: native.publish,
      query: native.query,
      searchProfiles: native.searchProfiles,
      upload: native.upload,
      media: native.media,
      gitAuth: native.gitAuth,
      remember: native.remember,
    },
    activity,
    // Typing goes where the turn answers, read the same way.
    soloChat: (agent, channel, signal) =>
      reads.soloChat(agent.owner, channel, signal),
    remembered: (agent, slug, body) => coreMemory.wrote(agent, slug, body),
    finished: (agent) => void coreMemory.refresh(agent),
    // Naming a Solo chat is the owner's signed write; this host holds only
    // the agent's key, so it leaves the name as it is.
    named: () => {},
  });
  function agentView() {
    return agent();
  }

  runners.reconcile(
    [{ pubkey, type: identity.type }],
    new Map([[identity.type, run.type]]),
  );
  run.sync([agentView()]);
  // As the app's agents hear its session (`AgentsService.listen`): a replay
  // (the recent history a subscription sends again before it goes live) is
  // heard only for what happened since this host started.
  const stopEvents = session.subscribeLive(
    (batch) => runners.dispatch(batch, () => true, started),
    { replay: true },
  );
  const onStatus = () => {
    const now = session.live.snapshot().status === "connected";
    if (now === live) return;
    live = now;
    log(now ? "Listening" : "Not listening");
    // Its core memory may have changed elsewhere while it was not connected.
    if (now) void coreMemory.refresh(pubkey);
    runners.resume(new Set(now ? [pubkey] : []));
  };
  const stopStatus = session.live.subscribe(onStatus);
  onStatus();
  // A roster the relay confirms decides the events held for it.
  const stopRosters = session.channels.subscribeList?.(() =>
    runners.releaseHeld(() => true),
  );
  let ticking = false;
  const tick = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      if (gone || (await isGone())) return;
      await files.reload();
      reread();
    } catch (error) {
      log(`Could not read the agent's settings: ${String(error)}`);
    } finally {
      ticking = false;
    }
    if (!gone) runners.tick();
  }, TICK_MS);
  log(`Running ${identity.name} (${identity.type})`);

  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= stopHosting());
  return stop;

  async function stopHosting() {
    clearInterval(tick);
    stopEvents();
    stopStatus();
    stopRosters?.();
    connection.relay.disconnect();
    runners.clear();
    // Only once its processes have exited may another copy run the agent.
    await run.dispose();
    await native.release(pubkey);
  }
}

/** Claude settings as the app resolves them: blank ones inherit the owner's
 * defaults, read as they are saved now, since the app may change them. */
export const claudeResolver = (storage: AgentStore) => (raw: unknown) =>
  claudeConfig(raw, claudeSaved(storage));
/** Codex settings as the app resolves them, without the app's model list: a
 * default model Codex no longer lists is left to Codex to report. */
export const codexResolver = (storage: AgentStore) => (raw: unknown) =>
  codexConfig(raw, codexSaved(storage));

function typeRun(
  typeId: string,
  pluginId: string,
  key: string,
  reads: (pubkey: string) => AgentReads | undefined,
  core: Core,
  storage: AgentStore,
): TypeRun {
  const registered = (
    type: Pick<RegisteredAgentType, "id" | "title" | "defaults"> &
      Partial<RegisteredAgentType>,
  ) =>
    Object.freeze({
      ...type,
      key,
      pluginId,
      revision: "standalone",
    }) as RegisteredAgentType;
  if (typeId === "claude-code") {
    const processes = processHost(
      claudeManifest.host.processes as readonly Declared[],
    );
    // Runs Buzz's own copy of Claude, which the desktop app keeps current.
    const runtime = new ClaudeRuntime(
      { spawn: claudeScript(processes.spawn) },
      reads,
      core,
      storage,
      claudeResolver(storage),
    );
    return {
      type: registered({
        id: typeId,
        title: "Claude",
        defaults: () => ({ config: DEFAULT_CONFIG }),
        ...claudeRun(runtime),
      }),
      sync: (agents) => runtime.sync(agents),
      dispose: () => {
        runtime.dispose();
        return processes.stopAll();
      },
    };
  }
  if (typeId === "codex") {
    const processes = processHost(
      codexManifest.host.processes as readonly Declared[],
    );
    // Runs Buzz's own copy of Codex, which the desktop app keeps current.
    const runtime = new CodexRuntime(
      codexScript(processes.spawn),
      reads,
      core,
      storage,
      codexResolver(storage),
    );
    return {
      type: registered({
        id: typeId,
        title: "Codex",
        defaults: () => ({ config: { ...codexDefaults } }),
        ...codexRun(runtime),
      }),
      sync: (agents) => runtime.sync(agents),
      dispose: () => {
        runtime.dispose();
        return processes.stopAll();
      },
    };
  }
  throw new Error(`This host cannot run ${key} agents`);
}
