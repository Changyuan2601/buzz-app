// The launch boundary: a mention goes through the real agents service, its
// runner and the start resolver into each real runtime, over a real relay
// session. The config the runtime actually uses comes from confirmed synced
// copies, the delivery carries their revision IDs, and the transport under
// the session sees no request at start beyond a turn's conversation reads,
// online or offline.
import { Context } from "@deepseek-ai/cordis";
import { finalizeEvent } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../host/service";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, profile, roster } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import { artifactD, readHead } from "./agent-config-artifacts";
import type { Mode } from "./agent-start";
import { createLocalAgentActivity } from "./local-activity";
import { type AgentReads, ownerReads } from "./reads";
import {
  type AgentCommunities,
  AgentsService,
  type AgentType,
  type ConfigBinding,
  type Delivery,
} from "./service";
import { fakeNative } from "./service-testing";
import { memoryStorage } from "./test-fakes";
import { claudeRun } from "../../bundled/claude-code/run";
import { ClaudeRuntime } from "../../bundled/claude-code/runtime";
import { AgentSessions as ClaudeSessions } from "../../bundled/claude-code/sessions";
import { fakeSpawn as fakeClaude } from "../../bundled/claude-code/claude-testing";
import { codexRun } from "../../bundled/codex/run";
import { CodexRuntime } from "../../bundled/codex/runtime";
import type { Wire } from "../../bundled/codex/rpc";
import { gooseRun } from "../../bundled/goose/run";
import { GooseRuntime } from "../../bundled/goose/runtime";
import { fakeSpawn as fakeGoose } from "../../bundled/goose/goose-testing";

const owner = keypair();
const relayKey = keypair();
const agentKey = keypair();
const artifactKey = keypair();
const origin = "https://relay.example.test";
const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const configChannel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const base = {
  owner: owner.pubkey,
  community: origin,
  subject: agentKey.pubkey,
  channel: configChannel,
};
const settingsSubject: Subject = { ...base, type: "buzz.agent.settings" };
const instructionsSubject: Subject = {
  ...base,
  type: "buzz.agent.instructions",
};

const revision = (body: object | null, op = "create") =>
  finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: body === null ? "" : JSON.stringify({ version: 1, ...body }),
      tags: [
        ["op", op],
        ["h", configChannel],
      ],
    },
    artifactKey.secret,
  ) as RelayEvent;

/** Confirmed copies in this device's storage, as a sync read installs them. */
function seed(storage: Storage, heads: [Subject, RelayEvent][]) {
  const store = new AgentConfigStore(storage);
  for (const [subject, head] of heads)
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: head,
    });
}

/** One request the transport saw: a read's filters, or an encrypted memory
 * listing (a request of its own, never a config read). */
type Request = {
  filters: readonly ReadFilter[];
  memory?: { agent: string; slug: string | undefined };
  failed: boolean;
  /** Whether every mention sent so far had finished when it was made. */
  afterRuns: boolean;
};

/** The one read a Codex turn makes of its conversation (§4.3): the mention
 * and its thread's replies, messages and their edits, in its channel, up to
 * the mention. */
const conversationRead = (sent: RelayEvent): readonly ReadFilter[] => {
  const window = { kinds: [40002, 9], "#h": [channel], until: sent.created_at };
  return [
    { ...window, ids: [sent.id], limit: 1 },
    { ...window, "#e": [sent.id], limit: 50 },
  ];
};

/** A transport that answers from `records`, recording every request it sees.
 * While `offline`, every request fails as an unreachable relay's does. */
function countedTransport(records: RelayEvent[]) {
  const requests: Request[] = [];
  const state = { offline: false, afterRuns: () => false };
  let live!: LiveCallbacks;
  const transport = {
    viewer: owner.pubkey,
    relayAuthor: relayKey.pubkey,
    scope: origin,
    media: () => undefined,
    async query(filters: readonly ReadFilter[]) {
      const request = {
        filters,
        failed: state.offline,
        afterRuns: state.afterRuns(),
      };
      requests.push(request);
      if (state.offline) throw new Error("Relay unreachable");
      return records.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
    async readAgentMemories(agent: string, _: AbortSignal, slug?: string) {
      requests.push({
        filters: [],
        memory: { agent, slug },
        failed: state.offline,
        afterRuns: state.afterRuns(),
      });
      if (state.offline) throw new Error("Relay unreachable");
      return { entries: [], partial: false };
    },
    subscribe(callbacks: LiveCallbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  };
  return { transport, requests, state, live: () => live };
}

const disposals: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Listing the agent in its community is not under test here.
vi.mock("./relay-removal", async (actual) => ({
  ...(await actual<typeof import("./relay-removal")>()),
  publishAgentRecord: vi.fn(async () => {}),
}));

async function setup<Config>(
  typeId: string,
  runs: (
    relay: (pubkey: string) => RelayData | undefined,
    reads: (pubkey: string) => AgentReads | undefined,
    core: AgentsService["core"],
  ) => Pick<
    AgentType<Config>,
    "run" | "runOnce" | "timeoutMs" | "syncedSettings"
  >,
  defaults: Config,
  heads: [Subject, RelayEvent][],
  binding: ConfigBinding,
) {
  const storage = memoryStorage();
  seed(storage, heads);
  const counted = countedTransport([
    metadata(relayKey, channel, "general"),
    roster(relayKey, channel, [owner.pubkey, agentKey.pubkey]),
    profile(owner, { name: "Owner" }),
    profile(agentKey, { name: typeId, is_agent: true }),
    ...heads.map(([, head]) => head),
  ]);
  const session = createRelaySession(counted.transport);
  disposals.push(() => session.dispose());
  const relayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      session: session.session,
      scope: `${origin}:${owner.pubkey}`,
      origin,
      viewer: owner.pubkey,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const communities = {
    snapshot: () => ({
      viewer: owner.pubkey,
      selected: origin,
      memberships: [{ id: origin, name: "Test" }],
    }),
    subscribe: () => () => {},
    open: () => relayData,
  } as unknown as AgentCommunities;
  const native = fakeNative([
    {
      pubkey: agentKey.pubkey,
      name: typeId,
      owner: owner.pubkey,
      relay: "wss://relay.example.test",
      type: `buzz/${typeId}`,
      deleted: false,
    },
  ]);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const activity = createLocalAgentActivity();
  /** Each start's binding lookup: one per start attempt. */
  const attempts = vi.fn(() => binding);
  const service = new AgentsService(
    ctx,
    communities,
    native,
    storage,
    undefined,
    activity,
    undefined,
    attempts,
  );
  disposals.push(() => ctx.fiber.dispose());
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "buzz", revision: "one" }),
  });
  const deliveries: Delivery<Config>[] = [];
  const real = runs(
    (pubkey) => service.relay(pubkey),
    (pubkey) => ownerReads(service.relay(pubkey), pubkey),
    (pubkey, signal) => service.core(pubkey, signal),
  );
  plugin.agents.register<Config>({
    id: typeId,
    title: typeId,
    defaults: () => ({ config: defaults }),
    ...real,
    run: (delivery) => {
      deliveries.push(delivery);
      return real.run?.(delivery);
    },
  });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  // Settle every cache a start may consult before counting begins.
  session.session.channels.ensureList();
  counted.live().state({ status: "connected", routes: [] });
  await vi.waitFor(() =>
    expect(service.snapshot().agents.map((agent) => agent.pubkey)).toContain(
      agentKey.pubkey,
    ),
  );
  // Discovery lists the channel only once it has applied its access change,
  // which would cancel reads still in flight.
  await vi.waitFor(() =>
    expect(session.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [expect.objectContaining({ id: channel })],
    }),
  );
  await session.session.profiles.ensure([owner.pubkey, agentKey.pubkey]);
  await service.core(agentKey.pubkey);
  counted.requests.length = 0;
  let at = Math.floor(Date.now() / 1000);
  let mentions = 0;
  counted.state.afterRuns = () =>
    activity.reader
      .work()
      .filter((work) => !["waiting", "working"].includes(work.state)).length ===
    mentions;
  /** A new top-level mention from the owner: a new conversation. */
  const mention = (tags: string[][] = []) => {
    mentions++;
    const sent = message(owner, channel, "@agent hello", ++at, [
      ["p", agentKey.pubkey],
      ...tags,
    ]);
    counted.live().receive([sent], { phase: "live", channelId: channel });
    return sent;
  };
  /** A reply from the owner in `root`'s thread: the same conversation. */
  const reply = (root: RelayEvent) => {
    mentions++;
    const sent = message(owner, channel, "@agent again", ++at, [
      ["e", root.id, "", "reply"],
      ["p", agentKey.pubkey],
    ]);
    counted.live().receive([sent], { phase: "live", channelId: channel });
    return sent;
  };
  return {
    service,
    session: session.session,
    requests: counted.requests,
    transport: counted.state,
    deliveries,
    activity,
    attempts,
    mention,
    reply,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The runner's refresh of the agent's `core` memory once its work has
 * ended, for a later start that never waits on it (`runner.ts` `release`). */
const postRunCoreRefresh = (request: Request) =>
  request.afterRuns &&
  request.memory?.agent === agentKey.pubkey &&
  request.memory.slug === "core";

/** Apart from the post-run core refresh, the recorded requests are exactly
 * one conversation read for each of `conversations`, in order: an extra, a
 * wider or a different read fails. */
function expectOnlyAllowed(
  f: Fixture,
  conversations: readonly RelayEvent[] = [],
) {
  expect(
    f.requests
      .filter((request) => !postRunCoreRefresh(request))
      .map((request) => request.filters),
  ).toEqual(conversations.map(conversationRead));
}

const synced = (mode: Mode = "synced") => ({
  settings: { mode, subject: settingsSubject },
  instructions: { mode, subject: instructionsSubject },
});

/** Synced copies for `agentType`: these settings, and instructions. */
function heads(agentType: string, settings: Record<string, string>) {
  const s = revision({ agentType, settings });
  const i = revision({ text: "SYNCED INSTRUCTIONS" });
  return {
    revisions: [s.id, i.id],
    seeded: [
      [settingsSubject, s],
      [instructionsSubject, i],
    ] as [Subject, RelayEvent][],
  };
}

/** The same counter records a real config sync read once the relay is back. */
async function expectCounterSeesSync(f: Fixture) {
  f.transport.offline = false;
  f.requests.length = 0;
  const read = f.session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  await readHead(
    read,
    configChannel,
    await artifactD("buzz.agent.settings", configChannel),
  );
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.filters[0]).toMatchObject({
    kinds: [45010],
    "#h": [configChannel],
  });
}

/** Wires `runtime` to the service as its plugin does (`index.ts`): it sees
 * the agent's local config now and after every change, before any delivery
 * carries the synced one. Returns the sync, for a test to run after an edit. */
function plugged(
  f: Fixture,
  runtime: Pick<ClaudeRuntime | GooseRuntime | CodexRuntime, "sync">,
) {
  const sync = () =>
    runtime.sync(
      f.service
        .snapshot()
        .running.filter((agent) => agent.pubkey === agentKey.pubkey),
    );
  disposals.push(f.service.subscribe(sync));
  sync();
  return sync;
}

/** Another device edits the synced settings: a new confirmed head arrives. */
function remoteEdit(
  f: Fixture,
  agentType: string,
  settings: Record<string, string>,
) {
  const store = (f.service as unknown as { configStore: AgentConfigStore })
    .configStore;
  store.applyRead(settingsSubject, store.capture(settingsSubject), {
    kind: "head",
    event: revision({ agentType, settings }),
  });
}

it("starts Claude sessions from the synced copies, with no relay request online or offline", async () => {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { revisions, seeded } = heads("buzz/claude-code", {
    model: "synced-model",
    scope: "thread",
  });
  let runtime!: ClaudeRuntime;
  const f = await setup(
    "claude-code",
    (_relay, reads, core) => {
      runtime = new ClaudeRuntime(host, reads, core, memoryStorage());
      return claudeRun(runtime);
    },
    {
      model: "local-model",
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  plugged(f, runtime);
  // The local sync warms spare processes on the local row; only the ones a
  // delivery prompted count.
  const used = () =>
    claude.processes.filter((process) => process.prompts.length);
  const prompted = (index: number) =>
    vi.waitFor(() =>
      expect(JSON.stringify(used()[index]?.received)).toContain(
        "SYNCED INSTRUCTIONS",
      ),
    );
  f.mention();
  await prompted(0);
  const [first] = used();
  expect(first?.model).toBe("synced-model");
  expect(first?.options.cwd).toBe("/this/device");
  expect(JSON.stringify(first?.received)).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);

  // The relay goes away; the next conversation starts from the same copies.
  f.transport.offline = true;
  f.mention();
  await prompted(1);
  expect(used()[1]?.model).toBe("synced-model");
  expect(JSON.stringify(used()[1]?.received)).not.toContain(
    "LOCAL INSTRUCTIONS",
  );
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);
  await expectCounterSeesSync(f);
});

it("keeps a running Claude conversation on its config after a synced edit until Restart to apply, and starts new ones on the edit", async () => {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { seeded } = heads("buzz/claude-code", {
    model: "synced-model",
    scope: "thread",
  });
  let runtime!: ClaudeRuntime;
  const f = await setup(
    "claude-code",
    (_relay, reads, core) => {
      runtime = new ClaudeRuntime(host, reads, core, memoryStorage());
      return claudeRun(runtime);
    },
    {
      model: "local-model",
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const sync = plugged(f, runtime);
  /** Whether a conversation runs on config other than the current synced
   * copy, which the last delivery carried. */
  const outdated = () =>
    runtime.outdated(agentKey.pubkey, f.deliveries.at(-1)?.config);
  /** The processes that took a prompt, not the spare one waiting. */
  const used = () =>
    claude.processes.filter((process) => process.prompts.length);
  const prompts = () =>
    used().map((process) => [process.model, process.prompts.length]);

  const root = f.mention();
  await vi.waitFor(() => expect(prompts()).toEqual([["synced-model", 1]]));

  remoteEdit(f, "buzz/claude-code", { model: "edited-model", scope: "thread" });
  sync();
  const reply = () => f.reply(root);
  reply();
  await vi.waitFor(() => expect(prompts()).toEqual([["synced-model", 2]]));
  expect(used()[0]?.killed).toBe(false);
  expect(outdated()).toBe(true);

  // A new conversation starts on the edit.
  f.mention();
  await vi.waitFor(() =>
    expect(prompts()).toEqual([
      ["synced-model", 2],
      ["edited-model", 1],
    ]),
  );
  expect(outdated()).toBe(true);

  // Restart to apply moves the first conversation onto the edit.
  runtime.restart(agentKey.pubkey);
  reply();
  await vi.waitFor(() =>
    expect(prompts()).toEqual([
      ["synced-model", 2],
      ["edited-model", 1],
      ["edited-model", 1],
    ]),
  );
  expect(used()[0]?.killed).toBe(true);
  expect(outdated()).toBe(false);
});

/** A Codex app server that answers what a thread and a turn need. */
function fakeCodex() {
  const sent: Wire[] = [];
  let options: HostProcessOptions | undefined;
  const emit = (value: Wire) =>
    options?.onStdout?.(`${JSON.stringify(value)}\n`);
  const process = {
    write: async (data: string) => {
      const request: Wire = JSON.parse(data);
      sent.push(request);
      if (request.id == null || !request.method) return;
      const params = request.params as Record<string, unknown>;
      const result =
        request.method === "thread/start" || request.method === "thread/resume"
          ? {
              thread: {
                id: params.threadId ?? `thread-${sent.length}`,
                cwd: params.cwd,
              },
            }
          : request.method === "turn/start"
            ? { turn: { id: `turn-${sent.length}` } }
            : request.method === "model/list"
              ? {
                  data: ["local-model", "synced-model"].map((model) => ({
                    model,
                    displayName: model,
                    isDefault: model === "local-model",
                    defaultReasoningEffort: "low",
                    supportedReasoningEfforts: ["low", "high"].map(
                      (reasoningEffort) => ({
                        reasoningEffort,
                        description: "",
                      }),
                    ),
                  })),
                  nextCursor: null,
                }
              : request.method === "config/read"
                ? { config: {} }
                : {};
      emit({ id: request.id, result });
      // Each turn finishes at once, so the next conversation can start.
      if (request.method === "turn/start")
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { ...(result as { turn: object }).turn, status: "completed" },
          },
        });
    },
    end: async () => {},
    kill: async () => {},
    exited: new Promise<number | null>(() => {}),
  };
  const spawn = async (id: string, value?: HostProcessOptions) => {
    if (id === "workspace") {
      value?.onStdout?.(`${value.cwd ?? ""}\n`);
      return { ...process, exited: Promise.resolve(0) };
    }
    options = value;
    return process;
  };
  return { spawn, sent };
}

it("starts a Codex thread and a turn from the synced copies; offline, only its conversation reads fail", async () => {
  const codex = fakeCodex();
  const { revisions, seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "high",
    scope: "thread",
  });
  const f = await setup(
    "codex",
    (_relay, reads, core) =>
      codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "low",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const starts = (method: string) =>
    codex.sent.filter((wire) => wire.method === method);
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  const first = f.mention();
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  const [thread] = starts("thread/start");
  expect(thread?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  const sentToCodex = JSON.stringify(codex.sent);
  expect(sentToCodex).toContain("SYNCED INSTRUCTIONS");
  expect(sentToCodex).not.toContain("LOCAL INSTRUCTIONS");
  expect(starts("turn/start")).toHaveLength(1);
  expect(starts("turn/start")[0]?.params).toMatchObject({ effort: "high" });
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [first]);

  // Offline until the second mention ends: the thread still opens from the
  // copies, and the turn fails on its conversation reads alone (§4.3).
  f.transport.offline = true;
  f.requests.length = 0;
  const second = f.mention();
  await vi.waitFor(() => expect(outcome(second.id)?.state).toBe("error"));
  expect(outcome(second.id)?.error).toBe("Relay unreachable");
  expect(starts("thread/start")).toHaveLength(2);
  expect(starts("thread/start")[1]?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  expect(starts("turn/start")).toHaveLength(1);
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  // Until the run ended, the turn's conversation read was all it asked, and
  // it failed.
  expectOnlyAllowed(f, [second]);
  expect(
    f.requests.filter((request) => !postRunCoreRefresh(request)),
  ).toMatchObject([{ failed: true }]);
  await expectCounterSeesSync(f);
});

const GOOSE_LOCAL = {
  model: "local-model",
  provider: "local-provider",
  effort: "",
  instructions: "LOCAL INSTRUCTIONS",
  workspace: "/this/device",
  scope: "thread" as const,
};

function gooseHost() {
  const goose = fakeGoose({
    providers: [
      { providerId: "synced-provider", models: [{ modelId: "synced-model" }] },
    ],
    supported: ["synced-model"],
  });
  const host = { spawn: goose.spawn, serveMcp: goose.serve } as unknown as Host;
  return { goose, host };
}

it("starts Goose sessions from the synced copies, with no relay request online or offline", async () => {
  const { goose, host } = gooseHost();
  const { revisions, seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  let runtime!: GooseRuntime;
  const f = await setup(
    "goose",
    (relay, _reads, core) => {
      runtime = new GooseRuntime(host, relay, core);
      return gooseRun(runtime);
    },
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
  );
  plugged(f, runtime);
  f.mention();
  const process = () => goose.geese[0];
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(1));
  const used = () => JSON.stringify([process()?.opened, process()?.configured]);
  expect(used()).toContain("synced-model");
  expect(used()).toContain("synced-provider");
  expect(used()).not.toContain("local-model");
  expect(process()?.opened[0]).toMatchObject({ cwd: "/this/device" });
  const prompts = () =>
    JSON.stringify([...(process()?.prompts.values() ?? [])]);
  expect(prompts()).toContain("SYNCED INSTRUCTIONS");
  expect(prompts()).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);

  f.transport.offline = true;
  f.mention();
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(2));
  expect(process()?.opened).toHaveLength(2);
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);
  await expectCounterSeesSync(f);
});

it("keeps a running Goose conversation on its config after a synced edit until Restart to apply, and starts new ones on the edit", async () => {
  const { goose, host } = gooseHost();
  const { seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  let runtime!: GooseRuntime;
  const f = await setup(
    "goose",
    (relay, _reads, core) => {
      runtime = new GooseRuntime(host, relay, core);
      return gooseRun(runtime);
    },
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
  );
  const sync = plugged(f, runtime);
  const outdated = () =>
    runtime.outdated(agentKey.pubkey, f.deliveries.at(-1)?.config);
  const process = () => goose.geese[0];
  /** Each turn's session, and the models set on each session. */
  const turns = () => process()?.turns.map((turn) => turn.sessionId);
  const models = () =>
    process()?.configured.filter((line) => line.includes("model="));

  const root = f.mention();
  await vi.waitFor(() => expect(turns()).toEqual(["session-1"]));
  expect(models()).toEqual(["session-1 model=synced-model"]);

  remoteEdit(f, "buzz/goose", {
    model: "edited-model",
    provider: "synced-provider",
    scope: "thread",
  });
  sync();
  const reply = () => f.reply(root);
  reply();
  await vi.waitFor(() => expect(turns()).toEqual(["session-1", "session-1"]));
  expect(process()?.closed).toEqual([]);
  expect(models()).toEqual(["session-1 model=synced-model"]);
  expect(outdated()).toBe(true);

  // A new conversation opens on the edit.
  f.mention();
  await vi.waitFor(() => expect(turns()).toHaveLength(3));
  expect(models()).toEqual([
    "session-1 model=synced-model",
    "session-2 model=edited-model",
  ]);
  expect(outdated()).toBe(true);

  // Restart to apply moves the first conversation onto the edit.
  runtime.restart(agentKey.pubkey);
  await vi.waitFor(() => expect(process()?.closed).toContain("session-1"));
  expect(outdated()).toBe(false);
  reply();
  await vi.waitFor(() => expect(turns()).toHaveLength(4));
  expect(models()?.at(-1)).toBe("session-3 model=edited-model");
});

it("refuses to start from deleted synced settings once: no launch, the reason on the mention, no retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { goose, host } = gooseHost();
  const deleted = revision(null, "delete");
  const { seeded } = heads("buzz/goose", { model: "synced-model" });
  const f = await setup(
    "goose",
    (relay, _reads, core) => gooseRun(new GooseRuntime(host, relay, core)),
    { ...GOOSE_LOCAL },
    [[settingsSubject, deleted], seeded[1] as [Subject, RelayEvent]],
    synced(),
  );
  f.attempts.mockClear();
  const sent = f.mention();
  const work = () =>
    f.activity.reader.work().filter((item) => item.messageId === sent.id);
  await vi.waitFor(() => expect(work()[0]?.state).toBe("error"));
  expect(work()).toEqual([
    expect.objectContaining({
      state: "error",
      error: "Settings were deleted — restore from History",
    }),
  ]);
  // Past the service's next tick, which runs whatever is still queued.
  await vi.advanceTimersByTimeAsync(6_000);
  expect(f.attempts).toHaveBeenCalledTimes(1);
  expect(work()).toHaveLength(1);
  expect(f.deliveries).toEqual([]);
  expect(goose.geese).toEqual([]);
  expectOnlyAllowed(f);
});

/** The mention's single outcome, once its work has ended. */
async function refused(f: Fixture, sent: RelayEvent) {
  const work = () =>
    f.activity.reader.work().filter((item) => item.messageId === sent.id);
  await vi.waitFor(() => expect(work()[0]?.state).toBe("error"));
  expect(work()).toHaveLength(1);
  return work()[0]?.error;
}

it("refuses a Codex start whose synced effort its model lacks, rather than run at the default", async () => {
  const codex = fakeCodex();
  const { seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "xhigh",
    scope: "thread",
  });
  const f = await setup(
    "codex",
    (_relay, reads, core) =>
      codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "low",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const error = await refused(f, f.mention());
  expect(error).toBe(
    'The synced effort "xhigh" isn\'t available for synced-model. Choose a supported effort in Settings.',
  );
  expect(codex.sent.filter((wire) => wire.method === "turn/start")).toEqual([]);
});

/** A Claude agent whose local row runs `local` and whose synced settings run
 * `model` at `effort`, synced into the runtime from the local row first, as
 * the plugin does before any delivery. */
async function claudeSynced(local: string, model: string, effort: string) {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { seeded } = heads("buzz/claude-code", {
    model,
    effort,
    scope: "thread",
  });
  let runtime!: ClaudeRuntime;
  const f = await setup(
    "claude-code",
    (_relay, reads, core) => {
      runtime = new ClaudeRuntime(host, reads, core, memoryStorage());
      return claudeRun(runtime);
    },
    {
      model: local,
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  plugged(f, runtime);
  // Which instructions a running entry gets is option A's to settle; this
  // is only whether a turn was handed to Claude at all.
  const prompted = () =>
    claude.processes.some((p) =>
      JSON.stringify(p.received).includes("@agent hello"),
    );
  return { f, prompted };
}

it("starts a Claude turn whose synced effort only the synced model offers", async () => {
  const { f, prompted } = await claudeSynced("haiku", "opus", "xhigh");
  f.mention();
  await vi.waitFor(() => expect(prompted()).toBe(true));
});

it("refuses a Claude start whose synced effort the synced model lacks, though the local model has it", async () => {
  const { f, prompted } = await claudeSynced("opus", "haiku", "xhigh");
  expect(await refused(f, f.mention())).toBe(
    'The synced effort "xhigh" isn\'t available for Haiku 5.5. Choose a supported effort in Settings.',
  );
  expect(prompted()).toBe(false);
});

it("refuses a synced Claude effort it can't check when Claude lists no models", async () => {
  vi.spyOn(ClaudeSessions.prototype, "metadata").mockResolvedValue({
    models: [],
    model: undefined,
    effort: undefined,
  });
  const { f, prompted } = await claudeSynced("opus", "opus", "high");
  expect(await refused(f, f.mention())).toBe(
    "The synced effort \"high\" couldn't be checked: Claude doesn't list the model opus.",
  );
  expect(prompted()).toBe(false);
});

it("refuses a pinned synced effort after a supported first-turn composer override", async () => {
  const codex = fakeCodex();
  const { seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "xhigh",
    scope: "thread",
  });
  let runtime!: CodexRuntime;
  const f = await setup(
    "codex",
    (_relay, reads, core) => {
      runtime = new CodexRuntime(codex.spawn, reads, core, memoryStorage());
      disposals.push(() => runtime.dispose());
      return codexRun(runtime);
    },
    {
      model: "local-model",
      effort: "low",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  plugged(f, runtime);
  const turns = () => codex.sent.filter((wire) => wire.method === "turn/start");
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  const first = f.mention([
    ["model", agentKey.pubkey, "local-model"],
    ["effort", agentKey.pubkey, "high"],
  ]);
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  expect(f.deliveries[0]).toMatchObject({
    model: "local-model",
    effort: "high",
    synced: { effort: "xhigh" },
    config: { model: "synced-model", effort: "xhigh" },
  });
  expect(turns()).toHaveLength(1);
  expect(turns()[0]?.params).toMatchObject({
    model: "local-model",
    effort: "high",
  });
  const next = f.reply(first);
  await vi.waitFor(() =>
    expect(["done", "error"]).toContain(outcome(next.id)?.state),
  );
  expect(f.deliveries[1]?.model).toBeUndefined();
  expect(f.deliveries[1]?.effort).toBeUndefined();
  expect({
    state: outcome(next.id)?.state,
    error: outcome(next.id)?.error,
    turns: turns().map((wire) => {
      const { model, effort } = wire.params as {
        model: string;
        effort: string;
      };
      return { model, effort };
    }),
  }).toEqual({
    state: "error",
    error:
      'The synced effort "xhigh" isn\'t available for synced-model. Choose a supported effort in Settings.',
    turns: [{ model: "local-model", effort: "high" }],
  });
});

it("keeps a valid Codex pin's effort after an unsupported remote edit", async () => {
  const codex = fakeCodex();
  const { seeded } = heads("buzz/codex", {
    model: "local-model",
    effort: "high",
    scope: "thread",
  });
  let runtime!: CodexRuntime;
  const f = await setup(
    "codex",
    (_relay, reads, core) => {
      runtime = new CodexRuntime(codex.spawn, reads, core, memoryStorage());
      disposals.push(() => runtime.dispose());
      return codexRun(runtime);
    },
    {
      model: "local-model",
      effort: "low",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const sync = plugged(f, runtime);
  const turns = () => codex.sent.filter((wire) => wire.method === "turn/start");
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  const first = f.mention();
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  remoteEdit(f, "buzz/codex", {
    model: "synced-model",
    effort: "xhigh",
    scope: "thread",
  });
  sync();
  const next = f.reply(first);
  await vi.waitFor(() => expect(outcome(next.id)?.state).toBe("done"));
  expect(f.deliveries[1]).toMatchObject({
    synced: { effort: "xhigh" },
    config: { model: "synced-model", effort: "xhigh" },
  });
  expect(turns()).toHaveLength(2);
  expect(turns()[1]?.params).toMatchObject({
    model: "local-model",
    effort: "high",
  });
});
