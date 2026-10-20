// A standalone agent host: runs one of the agents the desktop app saved on
// this machine, with the same runner and agent type code the app runs, while
// the app does not run it. The app's own claim protocol decides which copy
// runs the agent, so opening the installed app takes it over, and quitting
// the app lets this host take it back.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
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
import { nodeClient } from "../buzz-mcp/node";
import { CoreMemoryCache } from "../features/agents/core-memory-cache";
import { createLocalAgentActivity } from "../features/agents/local-activity";
import type { AgentReads } from "../features/agents/reads";
import { communityDestination } from "../features/communities/destination";
import type { Checkpoint } from "../features/agents/catch-up";
import { AgentRunners } from "../features/agents/runner";
import {
  type Agent,
  type RegisteredAgentType,
  teamPrompt,
} from "../features/agents/service";
import {
  type AgentRecord,
  type AgentStore,
  localStore,
  readOne,
  readTeams,
  recordKey,
  setAttention,
  withProgress,
  writeRecord,
} from "../features/agents/store";
import { eventsDto, type RelayEvent } from "../features/relay/events";
import { relayPartition } from "../features/relay/partition";
import { Claims } from "./claim";
import { AgentFeed } from "./feed";
import { checkSaved, type Identity, readNames } from "./identity";
import { agentReads } from "./reads";
import { type Declared, processHost } from "./spawn";
import { stateStorage } from "./storage";

/** The kinds the app's custody signs for an agent, with its owner
 * attestation: agent-controller app_agent.rs `KINDS`, which a test keeps this
 * list equal to. The relay decides which channel changes it may make. */
export const KINDS: readonly number[] = Object.freeze([
  5, 7, 9, 9000, 9001, 9002, 9007, 9008, 9021, 9022, 20002, 30023, 40003, 40100,
  41010,
]);
/** Throws for a kind the app's custody would not sign. */
export function checkKind(kind: number) {
  if (!KINDS.includes(kind))
    throw new Error(`Agents cannot publish kind ${kind}`);
}
/** How often due timers are looked for, as in the app. */
const TICK_MS = 5_000;

/** Events checked as the app checks what custody gives back. */
const verified = (events: readonly unknown[]): RelayEvent[] =>
  eventsDto([...events]);

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
  identity: Identity;
  secret: Uint8Array;
  /** The app's agents directory: `identities.json`, the `hosts` locks, and
   * the agent storage the app and this host share. */
  dir: string;
  log(message: string): void;
  /** Called once the agent is deleted, erased or changed in the app: this
   * host has stopped hosting it, and must stop. */
  onGone(reason: string): void;
}>;

/** Runs the agent until the returned stop is called. */
export function host(options: HostOptions): () => Promise<void> {
  const { identity, secret, dir, log, onGone } = options;
  const { pubkey } = identity;
  if (getPublicKey(secret) !== pubkey)
    throw new Error("The key is not this agent's");
  const home = join(dir, "standalone", pubkey);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // The app's agent storage: the agent's settings, teams and sessions are the
  // ones the app shows and saves. Each write here is saved before it settles.
  const storage = localStore(stateStorage(join(dir, "state")));
  const client = nodeClient({
    relay: identity.relay,
    key: Buffer.from(secret).toString("hex"),
    ...(identity.auth ? { auth: identity.auth } : {}),
    root: home,
  });
  const reads: AgentReads = agentReads(client, identity.relay);
  let live = false;
  const readsOf = (agent: string) =>
    live && agent === pubkey ? reads : undefined;

  // The agent's core memory, read through its own reads, as the app keeps it.
  const coreMemory = new CoreMemoryCache(readsOf);
  const core: Core = (agent, signal) => coreMemory.core(agent, signal);

  const [pluginId = "", typeId = ""] = identity.type.split("/");
  const run = typeRun(typeId, pluginId, identity.type, readsOf, core, storage);
  const claims = new Claims(join(dir, "hosts"));
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
  /** Keeps `record` as the agent's: saved, when `write`. */
  const keep = async (record: AgentRecord, write = true) => {
    mine(record.pubkey);
    if (write) {
      await writeRecord(storage, record);
      saved = storage.get(recordKey(pubkey));
    }
    stored = record;
    view = undefined;
    run.sync([agentView()]);
  };
  // As the app's agents service: the record's changes run in order, each
  // from the record the one before it kept, and its timers wait for them.
  let changes: Promise<unknown> = Promise.resolve();
  let changing = 0;
  const feed = new AgentFeed({
    relay: identity.relay,
    secret,
    pubkey,
    ...(identity.auth ? { auth: JSON.parse(identity.auth) as string[] } : {}),
    // A replay (what the feed heard while not listening, or what a request
    // sent before its EOSE) waits for the agent's room; of it, only what
    // happened since this host started is heard.
    onEvents: (batch) => runners.dispatch(batch, () => true, started),
    onStatus: (now) => {
      if (now === live) return;
      live = now;
      log(now ? "Listening" : "Not listening");
      runners.resume(new Set(now ? [pubkey] : []));
    },
    log,
  });
  // Whether the app deleted, erased or changed the agent: then this host
  // stops, and tells its caller why.
  let gone = false;
  const isGone = () => {
    let reason: string | undefined;
    try {
      reason = checkSaved(dir, identity);
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
  // As the app scopes the agent's community, so saved sessions match.
  const scope = relayPartition(
    communityDestination(identity.relay).url,
    identity.owner,
  );
  const started = Math.floor(Date.now() / 1000);
  // Catch-up progress, kept only while this host runs. This host does not
  // catch up yet, so it neither reads nor writes the agent's saved progress
  // (its own key in agent storage): as before catch-up, it hears what happens
  // while it is connected.
  let checkpoints: Readonly<Record<string, Checkpoint>> = {};
  const runners = new AgentRunners({
    ready: (agent) => (live && agent === pubkey ? agentView() : undefined),
    agent: (agent) => (agent === pubkey ? agentView() : undefined),
    member: (_, event) => {
      const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
      return !!channel && feed.channels.has(channel);
    },
    dm: (_, event) => {
      const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
      return !!channel && feed.dm(channel);
    },
    // No catch-up: see `checkpoints`.
    community: () => undefined,
    records: () => [recordOf()],
    checkpoints: {
      read: () => checkpoints,
      write: (next) => {
        checkpoints = next;
      },
    },
    scope: () => scope,
    saved: (agent) => (agent === pubkey ? stored : undefined),
    record: (agent) => {
      mine(agent);
      return recordOf();
    },
    change: (agent, apply) => {
      mine(agent);
      changing++;
      const next = changes.then(async () => {
        try {
          const record = await apply(recordOf());
          await keep(record);
          return record;
        } finally {
          if (!--changing) runners.wake(pubkey);
        }
      });
      changes = next.catch(() => {});
      return next;
    },
    changing: () => changing > 0,
    timers: () => recordOf().timers ?? {},
    // Timers wait while a change is pending, and a save here finishes as it
    // is made, so progress applies to the newest record. Kept even when its
    // save fails, so a timer does not run again at once.
    progress: (agent, ran) => {
      mine(agent);
      const next = withProgress(recordOf(), ran);
      if (!next) return;
      keep(next).catch((error) => {
        log(`Could not save the timers' progress: ${String(error)}`);
        void keep(next, false);
      });
    },
    // Each run starts from its saved record, as the app's agents do while the
    // app binds no synced config to them: the synced copies are in the app's
    // web storage, which this host cannot read.
    start: (agent) => ({ ok: true, config: agent.config, revisions: [] }),
    team: (agent) => teamPrompt(readTeams(storage), readNames(dir), agent),
    // Channel templates live in the app's web storage, which this host
    // cannot read; its agent offers none.
    templates: () => [],
    // Thread tabs are the owner's, in the app.
    tabs: () => undefined,
    // The classifier key is in the app's Keychain entry: no event watch here
    // is checked by a classifier, as in an app without one.
    classifier: () => "unavailable",
    jev: () => undefined,
    jevStatus: () => undefined,
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
        if (gone || isGone()) return false;
        try {
          return await claims.claim(agent);
        } catch (error) {
          // Unlike the app, which always runs its agents, this host runs one
          // only when it knows no other copy does.
          log(`Could not check who runs the agent: ${String(error)}`);
          return false;
        }
      },
      release: (agent) => claims.release(agent),
      publish: async (agent, event) => {
        mine(agent);
        checkKind(event.kind);
        const posted = await client.publish({
          kind: event.kind,
          content: event.content,
          tags: event.tags ?? [],
        });
        return verified([posted])[0] as RelayEvent;
      },
      query: async (agent, filters) => {
        mine(agent);
        return verified(
          await client.query(filters as readonly Record<string, unknown>[]),
        );
      },
      searchProfiles: async (agent, query, limit) => {
        mine(agent);
        const found = await client.searchProfiles?.(query, limit);
        return found && verified(found);
      },
      upload: (agent, data, mime) => {
        mine(agent);
        return client.upload(Buffer.from(data, "base64"), mime);
      },
      media: (agent, url) => {
        mine(agent);
        return client.media(url);
      },
      remember: async (agent, slug, body, after) => {
        mine(agent);
        return verified([
          await client.remember(slug, body, after),
        ])[0] as RelayEvent;
      },
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
  feed.start();
  const tick = setInterval(() => {
    if (gone || isGone()) return;
    try {
      reread();
    } catch (error) {
      log(`Could not read the agent's settings: ${String(error)}`);
    }
    runners.tick();
  }, TICK_MS);
  log(`Running ${identity.name} (${identity.type}) from ${home}`);

  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= stopHosting());
  return stop;

  async function stopHosting() {
    clearInterval(tick);
    feed.stop();
    runners.clear();
    // Only once its processes have exited may another copy run the agent.
    await run.dispose();
    await claims.release(pubkey);
    claims.dispose();
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
