// The Runner: the part of agents that runs them. It owns the agent runners
// and the agent storage they keep, which is records, catch-up progress, turns
// in progress and synced config copies. What it needs from the Manager, the
// part the screens use, it asks through `RunnerManager`; those facts and
// requests are what will cross the agents link when the Runner moves to its
// own page.
import { AgentConfigStore } from "./agent-config";
import { isSynced, resolveStart } from "./agent-start";
import {
  readCheckpoints,
  splitLegacyCheckpoints,
  writeCheckpoints,
  type Checkpoints,
} from "./catch-up";
import { originOf, RunnerConnections } from "./connections";
import { CoreMemoryCache } from "./core-memory-cache";
import { readInterrupted, writeInterrupted } from "./interrupted";
import type { LocalAgentActivity } from "./local-activity";
import { pubkeyOf, type AgentKey } from "./membership";
import { migrateWatchFilters } from "./migrate-filter";
import { migrateAgentStorage } from "./migrate-storage";
import type { AgentIdentity } from "./native";
import { ownerReads } from "./reads";
import { AgentRecords, type Member } from "./records";
import { AgentRunners, type Connection, type RunnerHost } from "./runner";
import type { Agent, ConfigBinding, RegisteredAgentType } from "./service";
import { soloChat } from "./solo-chat";
import { nameSoloChat } from "./solo-chat-name";
import type { AgentStore } from "./state";
import type { AgentRecord } from "./store";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { Decisions } from "../decisions/service";
import { channelTabs } from "../../bundled/channels/useChannelTabState";

/** What the Runner asks of the Manager. */
export type RunnerManager = Pick<
  RunnerHost,
  | "ready"
  | "agent"
  | "member"
  | "dm"
  | "team"
  | "createAgent"
  | "updateAgent"
  | "handoff"
  | "templates"
  | "classifier"
  | "keyStatus"
  | "classifierKey"
  | "classifierKeyGeneration"
  | "setClassifierKey"
  | "context"
  | "displayName"
> &
  Readonly<{
    /** Who runs which agent changed. */
    ownershipChanged(): void;
    /** A record or turn in progress changed what the screens show. */
    changed(): void;
    /** The community's relay, while the viewer is in it. */
    open(origin: string): RelayData | undefined;
    /** The agents running here, in every community. */
    running(): readonly Agent[];
    /** The membership of this key, unless it was deleted. */
    liveMember(key: AgentKey): Member | undefined;
    types(): readonly RegisteredAgentType[];
    /** The settings a new agent of this type starts with. */
    defaults(pubkey: string, type: RegisteredAgentType): AgentRecord;
    /** Which artifact types an agent has synced. */
    configBinding?: ((agent: Agent) => ConfigBinding) | undefined;
  }>;

export class AgentsRunner {
  /** Each membership's settings as saved, by key, and as the owner and the
   * agent see them. Its home record also keeps the agent's config. */
  readonly records: AgentRecords;
  readonly coreMemory: CoreMemoryCache;
  readonly runners: AgentRunners;
  /** The Runner's own live session of each community it runs agents in. */
  readonly connections: RunnerConnections;
  /** Confirmed synced config copies, the only synced launch source. */
  private readonly configStore: AgentConfigStore;

  constructor(
    storage: AgentStore,
    custody: RunnerHost["custody"],
    activity: LocalAgentActivity,
    decisions: Decisions | undefined,
    private readonly manager: RunnerManager,
  ) {
    // Each changes the copy at once and logs a failed save itself.
    void migrateAgentStorage(storage);
    void migrateWatchFilters(storage);
    this.records = new AgentRecords(storage, {
      defaults: ({ pubkey, type }) => {
        const kind = manager.types().find((entry) => entry.key === type);
        if (kind)
          try {
            return manager.defaults(pubkey, kind);
          } catch (error) {
            console.warn(`Agent type ${type} has invalid defaults`, error);
          }
      },
      changed: () => manager.changed(),
      // Its timers waited for this change, saved or failed.
      settled: (key) => this.runners.wake(key),
    });
    void splitLegacyCheckpoints(storage);
    this.configStore = new AgentConfigStore(storage);
    this.connections = new RunnerConnections({
      open: (origin) => manager.open(origin),
      listen: (session, origin, connection) =>
        this.listen(session, origin, connection),
      // The Manager's own session may change first: what runs is shown and
      // reconciled again once this one has.
      changed: () => manager.changed(),
    });
    this.coreMemory = new CoreMemoryCache((key) =>
      ownerReads(this.relay(key), pubkeyOf(key)),
    );
    /** The catch-up progress this program last read or saved. */
    let savedProgress: Checkpoints = {};
    this.runners = new AgentRunners({
      ownershipChanged: () => manager.ownershipChanged(),
      ready: (key) => manager.ready(key),
      agent: (key) => manager.agent(key),
      member: (agent, event) => manager.member(agent, event),
      dm: (agent, event) => manager.dm(agent, event),
      starting: (agent, channelId) =>
        this.connections
          .binding(agent)
          ?.session.channelWrites.starting(channelId),
      community: (agent) => this.connections.binding(agent),
      records: () => this.records.all(),
      checkpoints: {
        read: () => (savedProgress = readCheckpoints(storage)),
        write: (checkpoints) => {
          void writeCheckpoints(storage, checkpoints, savedProgress).catch(
            (error) => {
              console.warn("Agent catch-up progress was not saved", error);
              // The copy went back to what is saved: the next save compares
              // with that.
              savedProgress = readCheckpoints(storage);
            },
          );
          savedProgress = checkpoints;
        },
      },
      interrupted: {
        read: () => readInterrupted(storage),
        write: (key, turns) => {
          void writeInterrupted(storage, key, turns).catch((error) =>
            console.warn("Agent turns in progress were not saved", error),
          );
        },
        changed: () => manager.changed(),
      },
      scope: (agent) => this.connections.binding(agent)?.scope,
      saved: (key) => this.records.saved(key),
      record: (key) => {
        const member = manager.liveMember(key);
        if (!member) throw new Error("No such agent on this device");
        return this.records.recordOf(member);
      },
      change: async (key, apply) => {
        const record = await this.records.change(key, () => {
          const member = manager.liveMember(key);
          if (!member) throw new Error("No such agent on this device");
          // In turn, so this is the newest saved record.
          return apply(this.records.recordOf(member));
        });
        if (!record) throw new Error("No such agent on this device");
        return record;
      },
      changing: (key) => this.records.isChanging(key),
      timers: (key) => this.records.timersOf(key),
      progress: (key, ran) => this.records.progress(key, ran),
      start: (agent) => {
        const { settings, instructions } = manager.configBinding?.(agent) ?? {};
        const merge = manager
          .types()
          .find((type) => type.key === agent.type)?.syncedSettings;
        if (!merge && isSynced(this.configStore, settings))
          return {
            ok: false,
            state: "invalid",
            reason: "This agent type has no synced settings",
          };
        return resolveStart({
          store: this.configStore,
          local: agent.config as object,
          agentType: agent.type,
          ...(settings && merge
            ? {
                settings: {
                  ...settings,
                  schema: merge.schema,
                  withSynced: merge.withSynced as (
                    config: object,
                    synced: Readonly<Record<string, string>>,
                  ) => object,
                },
              }
            : {}),
          ...(instructions ? { instructions } : {}),
        });
      },
      team: (key) => manager.team(key),
      agentTypes: () =>
        manager
          .types()
          .filter((type) => !type.remote)
          .map(({ key, title }) => ({ key, title })),
      createAgent: (agent, input) => manager.createAgent(agent, input),
      updateAgent: (agent, input) => manager.updateAgent(agent, input),
      handoff: (agent, handoff) => manager.handoff(agent, handoff),
      templates: (agent) => manager.templates(agent),
      tabs: (agent) => {
        const session = this.connections.binding(agent)?.session;
        return session && channelTabs(session);
      },
      classifier: () => manager.classifier(),
      decisions: () => decisions,
      keyStatus: () => manager.keyStatus(),
      classifierKey: () => manager.classifierKey(),
      classifierKeyGeneration: () => manager.classifierKeyGeneration(),
      setClassifierKey: (key, generation) =>
        manager.setClassifierKey(key, generation),
      context: (agent, event) => manager.context(agent, event),
      displayName: (agent, pubkey) => manager.displayName(agent, pubkey),
      custody,
      activity,
      soloChat: (agent, channel, signal) =>
        soloChat(() => this.relay(agent.key), agent.owner, channel, signal),
      remembered: (key, slug, body) => this.coreMemory.wrote(key, slug, body),
      woke: (key, object) =>
        this.records.history(
          key,
          object,
          undefined,
          Math.floor(Date.now() / 1000),
        ),
      finished: (key) => void this.coreMemory.refresh(key),
      named: (agent, event, title) =>
        void nameSoloChat(
          this.relay(agent.key),
          agent.owner,
          agent.pubkey,
          event,
          title,
        ).catch((error) => console.warn("Couldn't name the Solo chat", error)),
    });
  }

  /** Connects each community where the viewer has an agent. */
  watch(identities: readonly AgentIdentity[], viewer: string | undefined) {
    this.connections.watch(identities, viewer);
  }
  /** The running agent's community, while the Runner is connected to it. */
  relay(key: AgentKey) {
    return this.connections.relay(
      originOf(this.manager.agent(key)?.relay ?? ""),
    );
  }
  clear() {
    this.connections.clear();
    this.runners.clear();
  }

  /** Delivers the session's live events, and retries what failed whenever its
   * connection recovers, which happens within the same session. A subscription
   * that comes back, after a reconnect or a failed route, first sends its
   * recent history again: what in it is new since this listener started was
   * missed while it was down, and is delivered now (`seen` drops the rest).
   * Older history is catch-up's, not replay's. */
  private listen(
    session: RelaySession,
    origin: string,
    connection: Connection,
  ) {
    let connected = session.live.snapshot().status === "connected";
    const since = connection.start;
    if (connected) Object.assign(connection, { epoch: 1, since });
    const heard = (agent: Agent) => originOf(agent.relay) === origin;
    const stopEvents = session.subscribeLive(
      (batch) => this.runners.dispatch(batch, heard, since),
      { replay: true },
    );
    const stopStatus = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (now !== connected) {
        // Catch-up reads what this connect may have missed, up to now.
        connection.epoch += now ? 1 : 0;
        connection.since = now ? Math.floor(Date.now() / 1000) : undefined;
      }
      if (now && !connected) this.refreshCore(origin);
      connected = now;
      this.runners.catchUp(false);
    });
    // A roster the relay confirms decides the events held for it.
    const stopRosters = session.channels.subscribeList?.(() =>
      this.runners.releaseHeld(heard),
    );
    return () => {
      stopEvents();
      stopStatus();
      stopRosters?.();
    };
  }
  /** Refreshes the cached `core` memory of each agent running in the
   * community, which may have changed elsewhere while it was not connected. */
  refreshCore(origin: string) {
    for (const agent of this.manager.running())
      if (originOf(agent.relay) === origin)
        void this.coreMemory.refresh(agent.key);
  }
}
