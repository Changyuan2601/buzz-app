import { createLocalAgentActivity, type WorkOutcome } from "./local-activity";
import { createHash } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { schnorr } from "@noble/curves/secp256k1.js";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigStore, type Subject } from "./agent-config";
import type { Mode } from "./agent-start";
import { channelTemplates } from "../channel-templates/local";
import { eventDto, type ReadFilter, type RelayEvent } from "../relay/events";
import { keypair, message, signed } from "../relay/testing";
import type { LiveBatch } from "../relay/incoming";
import type { RelaySession } from "../relay/session";
import type { AgentIdentity } from "./native";
import {
  agentConfigs,
  type CommunityConfigInput,
  type ConfigJournals,
} from "./community-config";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactTemplate,
} from "./agent-config-artifacts";
import { revertTemplate } from "./agent-config-history";
import {
  TEAMS_MIGRATION_KEY,
  TeamJournal,
  UNREADABLE_TEAM,
} from "./team-config";
import { type TeamOp, TeamOps } from "./team-ops";

/** The members a team change hasn't confirmed added yet. */
const pending = (op: TeamOp | undefined) =>
  op?.commands.flatMap((c) =>
    c.action === "add" && c.state !== "confirmed" && c.pubkey ? [c.pubkey] : [],
  );
import {
  type Agent,
  AgentsService,
  type AgentType,
  type ConfigBinding,
  type Delivery,
  type Trigger,
  fromOwner,
  localKey,
  teamPrompt,
} from "./service";
import type { ClassifierNative } from "./classifier";
import { CATCH_UP_KEY, readCheckpoints } from "./catch-up";
import { memoryStorage } from "./test-fakes";
import { MigrationJournal } from "./config-writes";
import { STANDALONE_DEADLINE_MS } from "../agent-harness/standalone";
import { readTeams, TEAMS_KEY, writeTeams } from "./store";
import { importedTeamId, teamSubject } from "./config-channels";
const COMMUNITY_UUID = "5b0c2f9e-3d1a-4c7b-9e8f-1a2b3c4d5e6f";
import {
  bot,
  channel,
  dm,
  event,
  fakeCommunities,
  fakeNative,
  fakeRelay,
  groupDm,
  other,
  sibling,
  steps,
  viewer,
} from "./service-testing";

/** The tag that the echo type's default watch matches. */
const DEPLOY = ["t", "deploy"];
/** A message the echo type's default watch matches. */
const deploy = (id: string, patch: Partial<RelayEvent> = {}) =>
  event(id, {
    content: "deploy",
    ...patch,
    tags: [["h", channel], DEPLOY, ...(patch.tags ?? [])],
  });

// Cleanup's channel step has its own coverage (relay-removal); here only its
// place in the order matters.
const leaveChannels = vi.hoisted(() => vi.fn());
// The viewer's kind 30177 records, as the community's outbox writes them.
const records = vi.hoisted(() => ({
  publish: vi.fn(),
  remove: vi.fn(),
  removeAgent: vi.fn(),
}));
vi.mock("./relay-removal", () => ({
  removeAgentFromChannels: leaveChannels,
  publishAgentRecord: records.publish,
  deleteAgentRecord: records.remove,
  removeRelayAgent: records.removeAgent,
}));

// Config channels are off in the app; lifecycle tests hand the service one
// community's config through this.
const communityFake = vi.hoisted(() => ({
  value: null as unknown,
}));
vi.mock("./community-config", async (actual) => ({
  ...(await actual<typeof import("./community-config")>()),
  communityConfig: async (input: unknown) =>
    typeof communityFake.value === "function"
      ? communityFake.value(input)
      : communityFake.value,
}));

const UNFINISHED =
  "Echo isn't deleted yet and may still be in some channels. It stays stopped; Delete it again to finish.";

type Config = { reply: string };
async function setup({
  storage = memoryStorage(),
  identities = [] as AgentIdentity[],
  listed = [] as RelayEvent[],
  history = [] as RelayEvent[],
  timeoutMs = 60_000,
  runOnce = undefined as AgentType<Config>["runOnce"],
  jev = undefined as ClassifierNative | undefined,
  binding = undefined as ((agent: Agent) => ConfigBinding) | undefined,
  models = async () => {},
  extraType = undefined as AgentType | undefined,
} = {}) {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const fake = fakeRelay();
  const second = fakeRelay("https://other.example.test");
  const client = fakeCommunities(fake, second);
  const native = fakeNative(identities);
  fake.listed.push(...listed);
  fake.history.push(...history);
  const authorize = vi.fn(
    async (_: string, __: AbortSignal) =>
      ["auth", viewer, "", "f".repeat(128)] as const,
  );
  const activity = createLocalAgentActivity();
  const service = new AgentsService(
    ctx,
    client.communities,
    native,
    storage,
    authorize,
    activity,
    jev,
    binding,
  );
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "example", revision: "one" }),
  });
  const run = vi.fn<(delivery: Delivery<Config>) => void | Promise<void>>();
  const type: AgentType<Config> = {
    id: "echo",
    title: "Echo",
    timeoutMs,
    adopt: (carry, saved) => ({ reply: carry.instructions ?? saved.reply }),
    carry: ({ reply }) => ({ instructions: reply, workspace: "~/echo" }),
    describeMigration: () => [
      { id: "model", label: "Model", isOverride: true },
      { id: "thinking", label: "Thinking", isOverride: true },
      {
        id: "sessions",
        label: "Sessions",
        isOverride: true,
        unchangedKey: "channel",
      },
      {
        id: "equivalent",
        label: "Equivalent setting",
        isOverride: true,
        unchangedKey: "same",
      },
      { id: "default", label: "Default setting", isOverride: false },
    ],
    defaults: () => ({
      config: { reply: "ok" },
      attention: {
        "interest/default": { type: "interest", instructions: "Be brief." },
        "watch/channel": {
          type: "event",
          interest_id: "default",
          enabled: true,
          since: 1,
          channels: [channel],
          kinds: [9],
          tags: { t: ["deploy"] },
        },
      },
    }),
    models: async () => {
      await models();
      return {
        current: "fast",
        models: [
          {
            id: "fast",
            label: "Fast",
            efforts: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
          { id: "deep", label: "Deep", efforts: [{ id: "max", label: "Max" }] },
        ],
      };
    },
    run,
    ...(runOnce ? { runOnce } : {}),
  };
  plugin.agents.register(type);
  if (extraType) plugin.agents.register(extraType);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  return {
    activity,
    service,
    type,
    native,
    storage,
    run,
    emit: fake.emit,
    confirm: fake.confirm,
    connect: fake.connect,
    signIn: fake.signIn,
    fail: fake.fail,
    relay: fake.relay,
    reconnecting: fake.reconnecting,
    recover: fake.recover,
    memories: fake.memories,
    archives: fake.archives,
    session: fake.session,
    history: fake.history,
    authorize,
    plugin,
    presence: fake.presence,
    second,
    select: client.select,
    leave: client.leave,
    communities: client.communities,
    ctx,
  };
}

/** Lets every pending promise chain finish: a macrotask runs only after the
 * microtask queue is empty, so this does not depend on how fast runners are. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The events native published as an agent, of `kind`, in order. */
async function published(native: ReturnType<typeof fakeNative>, kind: number) {
  const events = await Promise.all(
    native.publish.mock.results.map(({ value }) => value),
  );
  return events.filter((event) => event.kind === kind);
}

beforeEach(() => {
  vi.useRealTimers();
  steps.length = 0;
  leaveChannels.mockReset();
  leaveChannels.mockImplementation(async () => void steps.push("channels"));
  records.publish.mockReset();
  records.publish.mockImplementation(async () => {});
  records.remove.mockReset();
  records.remove.mockImplementation(async () => void steps.push("record"));
  records.removeAgent.mockReset();
  records.removeAgent.mockImplementation(async () => void steps.push("leave"));
});
afterEach(() => vi.useRealTimers());

it("creates an agent in the community shown, with its type's defaults, and publishes its profile", async () => {
  const { service, native } = await setup();
  const agent = await service.create({ type: "example/echo", name: " Echo " });
  expect(native.create).toHaveBeenCalledWith(
    "https://relay.example.test",
    viewer,
    "example/echo",
    "Echo",
  );
  expect(native.publishProfile).toHaveBeenCalledWith(bot);
  expect(agent).toMatchObject({
    pubkey: bot,
    name: "Echo",
    type: "example/echo",
    config: { reply: "ok" },
  });
  expect(Object.keys(agent.attention)).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  expect(service.find(bot)).toEqual(agent);
});

it("brings over an identity not already an agent, with its type's defaults and what it adopts, and publishes its profile", async () => {
  const { service, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const found = await service.portable();
  // `bot` is already an agent here; the warning still shows.
  expect(found.agents.map((agent) => agent.pubkey)).toEqual([sibling]);
  expect(found.warnings).toEqual(["Could not read one store"]);
  const { agent } = await service.port({
    source: "installed",
    pubkey: sibling,
    type: "example/echo",
  });
  expect(native.port).toHaveBeenCalledWith(
    "installed",
    sibling,
    "https://relay.example.test",
    viewer,
    "example/echo",
  );
  expect(native.publishProfile).toHaveBeenCalledWith(sibling);
  expect(agent).toMatchObject({
    pubkey: sibling,
    name: "Older",
    config: { reply: "Triage." },
  });
  expect(service.find(sibling)?.config).toEqual({ reply: "Triage." });
  expect(Object.keys(agent.attention)).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  await expect(
    service.port({ source: "harness", pubkey: bot, type: "nope/none" }),
  ).rejects.toThrow("That agent type is not available");
});

it("brings back unarchived an agent whose Delete cleanup archived it, or says it stays archived", async () => {
  const { service, archives } = await setup();
  archives.archived.add(sibling);
  const port = () =>
    service.port({
      source: "installed",
      pubkey: sibling,
      type: "example/echo",
    });
  const back = await port();
  expect(archives.request).toHaveBeenCalledWith(
    "unarchive",
    sibling,
    expect.any(AbortSignal),
  );
  expect(back.notes).toEqual([]);
  await service.remove(sibling);
  archives.archived.add(sibling);
  archives.request.mockClear();
  archives.consent.mockResolvedValue(null);
  const kept = await port();
  expect(archives.request).not.toHaveBeenCalled();
  expect(kept.notes).toEqual([
    "Older is still archived in this community, so it stays out of member lists and mentions there.",
  ]);
});

it("passes on what native says did not come over", async () => {
  const { service, native } = await setup();
  native.port.mockImplementationOnce(
    async (_, pubkey, destination, owner, type) => ({
      agent: {
        pubkey,
        relay: destination,
        owner,
        type,
        name: "Older",
        deleted: false,
      },
      carry: { instructions: "Triage." },
      notes: ["Older came over without its picture."],
    }),
  );
  const { notes } = await service.port({
    source: "installed",
    pubkey: sibling,
    type: "example/echo",
  });
  expect(notes).toEqual(["Older came over without its picture."]);
});

it("imports a shared agent as a new identity with its name and picture, adopting its instructions", async () => {
  const { service, native } = await setup();
  const { agent } = await service.port({
    source: "shared",
    type: "example/echo",
    name: " Baymax ",
    picture: "https://example.test/baymax.png",
    instructions: "Open drafts only.",
  });
  expect(native.create).toHaveBeenCalledWith(
    "https://relay.example.test",
    viewer,
    "example/echo",
    "Baymax",
  );
  expect(native.port).not.toHaveBeenCalled();
  expect(native.setPicture).toHaveBeenCalledWith(
    agent.pubkey,
    "https://example.test/baymax.png",
  );
  expect(agent).toMatchObject({
    name: "Baymax",
    picture: "https://example.test/baymax.png",
    config: { reply: "Open drafts only." },
  });
  // Without instructions it starts from the type's defaults.
  const { agent: plain } = await service.port({
    source: "shared",
    type: "example/echo",
    name: "Plain",
  });
  expect(plain.config).toEqual({ reply: "ok" });
  await expect(
    service.port({ source: "shared", type: "example/echo", name: "  " }),
  ).rejects.toThrow("Name the agent");
});

/** The imported copy of old Buzz team `id` for `owner` in `community`. */
const betaTeam = (
  id: string,
  community = "https://relay.example.test",
  owner = viewer,
) =>
  `beta-${createHash("sha256").update(`${id}\n${community}:${owner}`).digest("hex")}`;
const [alder, birch, carrow] = [bot, sibling, "e".repeat(64)];
const NAMES: Record<string, string> = {
  [alder]: "Alder",
  [birch]: "Birch",
  [carrow]: "Carrow",
};
/** Old Buzz's Night Shift as native lists it, with these members. */
const nightShift = (
  members: readonly string[],
  text: { name?: string; instructions?: string } = {},
) => ({
  id: "old-night-shift",
  name: "Night Shift",
  instructions: "Ship small.",
  ...text,
  members: members.map((pubkey) => ({
    pubkey,
    name: NAMES[pubkey] as string,
    source: "installed" as const,
  })),
});
/** Its copy here in `community`, as saved. */
const savedShift = (members: readonly string[], community?: string) => ({
  id: betaTeam("old-night-shift", community),
  name: "Night Shift",
  instructions: "Ship small.",
  members,
});
function listsTeam(
  native: ReturnType<typeof fakeNative>,
  team: ReturnType<typeof nightShift>,
) {
  native.portable.mockResolvedValue({
    agents: team.members.map(({ pubkey, name }) => ({
      source: "installed" as const,
      pubkey,
      name,
      relay: "",
    })),
    teams: [team],
    warnings: [],
  });
}
const importTeam = (service: AgentsService) =>
  service.portTeam({ id: "old-night-shift", type: "example/echo" });
const importOld = (service: AgentsService, pubkey: string) =>
  service.port({ source: "installed", pubkey, type: "example/echo" });
const portedKeys = (native: ReturnType<typeof fakeNative>) =>
  native.port.mock.calls.map(([, pubkey]) => pubkey);
const here = (pubkey: string, relay = "wss://relay.example.test") => ({
  pubkey,
  relay,
  owner: viewer,
  type: "example/echo",
  name: NAMES[pubkey] as string,
  deleted: false,
});

it("imports a team with the members that came, names the rest, and leaves later single imports off it", async () => {
  const { service, native, storage } = await setup();
  listsTeam(native, nightShift([alder, birch, carrow]));
  const port = native.port.getMockImplementation() as NonNullable<
    ReturnType<typeof native.port.getMockImplementation>
  >;
  native.port.mockImplementation(async (...args) => {
    if (args[1] === birch) throw new Error("Keychain access was denied");
    return port(...args);
  });
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, carrow]));
  expect(result.imported.map((agent) => agent.pubkey)).toEqual([alder, carrow]);
  expect(result.failed).toEqual([
    { name: "Birch", error: "Keychain access was denied" },
  ]);
  expect(result.teamError).toBeUndefined();
  // Imported on its own afterwards, it never joins the team.
  native.port.mockImplementation(port);
  const stored = storage.getItem("buzz.agents.teams.v1");
  await importOld(service, birch);
  expect(service.find(birch)).toBeDefined();
  expect(storage.getItem("buzz.agents.teams.v1")).toBe(stored);
  expect(service.snapshot().teams).toEqual([savedShift([alder, carrow])]);
});

it("puts members imported one by one on the team without importing them again", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  await importOld(service, alder);
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, birch]));
  expect(result.imported.map((agent) => agent.pubkey)).toEqual([birch]);
  expect(portedKeys(native)).toEqual([alder, birch]);
});

it("imports a team again without duplicates, keeping its edits here", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  await importTeam(service);
  await service.saveTeam({
    id: betaTeam("old-night-shift"),
    name: "Renamed",
    instructions: "Mine.",
    members: [alder, birch],
  });
  const again = await importTeam(service);
  expect(again.imported).toEqual([]);
  expect(service.snapshot().teams).toEqual([
    {
      id: betaTeam("old-night-shift"),
      name: "Renamed",
      instructions: "Mine.",
      members: [alder, birch],
    },
  ]);
  expect(portedKeys(native)).toEqual([alder, birch]);
});

it("never takes over a same-name team the owner made before importing", async () => {
  const { service, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const own = await service.saveTeam({
    name: "Night Shift",
    instructions: "Mine.",
    members: [bot],
  });
  listsTeam(native, nightShift([carrow]));
  await importTeam(service);
  expect(service.snapshot().teams).toEqual([own, savedShift([carrow])]);
});

it("recreates a deleted imported team when it is imported again", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder]));
  await importTeam(service);
  await service.removeTeam(betaTeam("old-night-shift"));
  const text = { name: "Late Shift", instructions: "Ship smaller." };
  listsTeam(native, nightShift([alder, birch], text));
  await importTeam(service);
  expect(service.snapshot().teams).toEqual([
    { ...savedShift([alder, birch]), ...text },
  ]);
});

it("saves the team as old Buzz has it at import, not as the list showed it", async () => {
  const { service, native } = await setup();
  listsTeam(
    native,
    nightShift([alder, birch], { name: "Listed", instructions: "Stale." }),
  );
  await service.portable();
  listsTeam(native, nightShift([alder, birch, carrow]));
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, birch, carrow]));
  expect(portedKeys(native)).toEqual([alder, birch, carrow]);
});

it("imports members one at a time, in order, then saves the team once", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  listsTeam(native, nightShift([alder, birch, carrow]));
  const steps: string[] = [];
  const port = native.port.getMockImplementation() as NonNullable<
    ReturnType<typeof native.port.getMockImplementation>
  >;
  native.port.mockImplementation(async (...args) => {
    steps.push(`start ${NAMES[args[1]]}`);
    const done = await port(...args);
    steps.push(`end ${NAMES[args[1]]}`);
    return done;
  });
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === "buzz.agents.teams.v1") steps.push("team");
    setItem(key, value);
  };
  await importTeam(service);
  expect(steps).toEqual([
    "start Alder",
    "end Alder",
    "start Birch",
    "end Birch",
    "start Carrow",
    "end Carrow",
    "team",
  ]);
});

it("names a member old Buzz no longer lists, and never imports it", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  const found = await native.portable();
  native.portable.mockResolvedValue({
    ...found,
    agents: found.agents.filter((agent) => agent.pubkey !== birch),
  });
  const result = await importTeam(service);
  expect(result.failed).toEqual([
    { name: "Birch", error: "No longer available in old Buzz" },
  ]);
  expect(portedKeys(native)).toEqual([alder]);
  expect(result.team).toEqual(savedShift([alder]));
});

it("names a member with no name by its short npub", async () => {
  const { service, native } = await setup();
  const team = nightShift([birch]);
  listsTeam(native, {
    ...team,
    members: team.members.map((member) => ({ ...member, name: "  " })),
  });
  native.port.mockRejectedValue(new Error("Keychain access was denied"));
  const result = await importTeam(service);
  expect(result.failed).toEqual([
    {
      name: `npub…${npubEncode(birch).slice(-3)}`,
      error: "Keychain access was denied",
    },
  ]);
});

it("imports every member into the community and owner the import started with", async () => {
  const { service, native, signIn } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  const listed = native.portable.getMockImplementation() as NonNullable<
    ReturnType<typeof native.portable.getMockImplementation>
  >;
  const other = "e".repeat(64);
  native.portable.mockImplementationOnce(async () => {
    // Same community, so the import carries on; a new owner signed in.
    signIn(other);
    return listed();
  });
  const result = await importTeam(service);
  for (const pubkey of [alder, birch])
    expect(native.port).toHaveBeenCalledWith(
      "installed",
      pubkey,
      "https://relay.example.test",
      viewer,
      "example/echo",
    );
  const stored = (await native.list()).map(({ pubkey, relay, owner }) => ({
    pubkey,
    relay,
    owner,
  }));
  expect(stored).toEqual(
    [alder, birch].map((pubkey) => ({
      pubkey,
      relay: "wss://relay.example.test",
      owner: viewer,
    })),
  );
  expect(result.team).toEqual(savedShift([alder, birch]));
});

it("keeps an agent of the import's owner on the team when another owner signs in meanwhile", async () => {
  const { service, native, signIn } = await setup({
    identities: [here(birch)],
  });
  listsTeam(native, nightShift([alder, birch]));
  const listed = native.portable.getMockImplementation() as NonNullable<
    ReturnType<typeof native.portable.getMockImplementation>
  >;
  native.portable.mockImplementationOnce(async () => {
    signIn("e".repeat(64));
    return listed();
  });
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, birch]));
  expect(result.elsewhere).toEqual([]);
  expect(result.foreign).toEqual([]);
});

it("imports nothing when the community changes while old Buzz is read", async () => {
  const { service, native, second, select } = await setup();
  listsTeam(native, nightShift([alder]));
  const listed = native.portable.getMockImplementation() as NonNullable<
    ReturnType<typeof native.portable.getMockImplementation>
  >;
  native.portable.mockImplementationOnce(async () => {
    select(second.origin);
    return listed();
  });
  await expect(importTeam(service)).rejects.toThrow("Community changed");
  expect(native.port).not.toHaveBeenCalled();
  expect(service.snapshot().teams).toEqual([]);
});

it("keeps a team import in the community it started in, stopping when another is opened", async () => {
  const { service, native, second, select } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  const port = native.port.getMockImplementation() as NonNullable<
    ReturnType<typeof native.port.getMockImplementation>
  >;
  native.port.mockImplementationOnce(async (...args) => {
    select(second.origin);
    return port(...args);
  });
  const result = await importTeam(service);
  expect(native.port).toHaveBeenCalledTimes(1);
  expect(native.port).toHaveBeenCalledWith(
    "installed",
    alder,
    "https://relay.example.test",
    viewer,
    "example/echo",
  );
  expect(result.failed).toEqual([
    { name: "Birch", error: "Community changed" },
  ]);
  expect(result.team).toEqual(savedShift([alder]));
  expect(service.snapshot().teams).toEqual([savedShift([alder])]);
  const relays = new Map(
    (await native.list()).map((identity) => [identity.pubkey, identity.relay]),
  );
  expect([...relays]).toEqual([[alder, "wss://relay.example.test"]]);
});

it("leaves a member that lives in another community off the team, and never moves it", async () => {
  const { service, native } = await setup({
    identities: [here(birch, "wss://other.example.test")],
  });
  listsTeam(native, nightShift([alder, birch]));
  expect((await service.portable()).here).toEqual([]);
  const result = await importTeam(service);
  expect(result.elsewhere).toEqual(["Birch"]);
  expect(result.team).toEqual(savedShift([alder]));
  expect(portedKeys(native)).toEqual([alder]);
});

it("leaves a member another account on this device has off the team, and names it", async () => {
  const { service, native } = await setup({
    identities: [{ ...here(birch), owner: "e".repeat(64) }],
  });
  listsTeam(native, nightShift([alder, birch]));
  expect((await service.portable()).here).toEqual([]);
  const result = await importTeam(service);
  expect(result.foreign).toEqual(["Birch"]);
  expect(result.elsewhere).toEqual([]);
  expect(result.team).toEqual(savedShift([alder]));
  expect(portedKeys(native)).toEqual([alder]);
});

it("drops another account's agents an earlier import left on the team, keeping its edits", async () => {
  const storage = memoryStorage();
  const other = "f".repeat(64);
  writeTeams(storage, [
    { ...savedShift([birch, carrow]), name: "Renamed", instructions: "Mine." },
  ]);
  const { service, native } = await setup({
    storage,
    identities: [
      { ...here(birch), owner: other },
      { ...here(carrow), owner: other },
    ],
  });
  listsTeam(native, nightShift([alder, birch]));
  const result = await importTeam(service);
  const team = {
    ...savedShift([alder]),
    name: "Renamed",
    instructions: "Mine.",
  };
  expect(result.foreign).toEqual(["Birch", "Carrow"]);
  expect(result.team).toEqual(team);
  expect(service.snapshot().teams).toEqual([team]);
  expect(readTeams(storage)).toEqual([team]);
});

it("drops another account's agents from a saved team even when no member imports", async () => {
  const storage = memoryStorage();
  const other = "f".repeat(64);
  writeTeams(storage, [
    { ...savedShift([carrow, birch]), name: "Renamed", instructions: "Mine." },
  ]);
  const { service, native } = await setup({
    storage,
    identities: [here(carrow), { ...here(birch), owner: other }],
  });
  listsTeam(native, nightShift([alder, birch]));
  native.port.mockRejectedValue(new Error("Keychain access was denied"));
  const result = await importTeam(service);
  const team = {
    ...savedShift([carrow]),
    name: "Renamed",
    instructions: "Mine.",
  };
  expect(result.foreign).toEqual(["Birch"]);
  expect(result.failed).toEqual([
    { name: "Alder", error: "Keychain access was denied" },
  ]);
  expect(service.snapshot().teams).toEqual([team]);
  expect(readTeams(storage)).toEqual([team]);
});

it("keeps each account's import of the same old team apart on one device", async () => {
  const { service, native, signIn } = await setup();
  const other = "f".repeat(64);
  const importAs = async (owner: string, member: string) => {
    signIn(owner);
    listsTeam(native, nightShift([member]));
    const { team } = await importTeam(service);
    if (!team) throw new Error("The team was not saved");
    return team;
  };
  const first = await importAs(viewer, alder);
  const mine = await service.saveTeam({
    ...first,
    name: "Renamed",
    instructions: "Mine.",
  });
  const theirs = await importAs(other, birch);
  expect(theirs).toEqual({
    ...savedShift([birch]),
    id: betaTeam("old-night-shift", undefined, other),
  });
  expect(service.snapshot().teams).toEqual([mine, theirs]);
  expect(await importAs(viewer, alder)).toEqual(mine);
  expect(service.snapshot().teams).toEqual([mine, theirs]);
});

it("creates no team when no member imports and none was saved", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  listsTeam(native, nightShift([alder]));
  native.port.mockRejectedValue(new Error("Keychain access was denied"));
  const result = await importTeam(service);
  expect(result.team).toBeUndefined();
  expect(service.snapshot().teams).toEqual([]);
  expect(readTeams(storage)).toEqual([]);
});

it("lists a team whose members are all here, and imports it from them", async () => {
  const { service, native } = await setup({
    identities: [here(alder), here(birch)],
  });
  listsTeam(native, nightShift([alder, birch]));
  const found = await service.portable();
  expect(found.agents).toEqual([]);
  expect(found.teams).toEqual([nightShift([alder, birch])]);
  expect(found.here).toEqual([alder, birch]);
  const result = await importTeam(service);
  expect(result).toEqual({
    team: savedShift([alder, birch]),
    imported: [],
    failed: [],
    elsewhere: [],
    foreign: [],
    notes: [],
  });
  expect(native.port).not.toHaveBeenCalled();
});

it("keeps a team's imported members when the team cannot be saved, and changes no team", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  await service.create({ type: "example/echo", name: "Echo" });
  await service.saveTeam({ name: "Crew", instructions: "", members: [bot] });
  const stored = storage.getItem("buzz.agents.teams.v1");
  const teams = service.snapshot().teams;
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === "buzz.agents.teams.v1") throw new Error("Quota exceeded");
    setItem(key, value);
  };
  listsTeam(native, nightShift([carrow]));
  const result = await importTeam(service);
  expect(result.teamError).toEqual({ name: "Night Shift" });
  expect(result.team).toBeUndefined();
  expect(service.find(carrow)).toBeDefined();
  expect(storage.getItem("buzz.agents.teams.v1")).toBe(stored);
  expect(service.snapshot().teams).toBe(teams);
});

it("delivers mentions and matching watches once, and never the agent's own events", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const mention = event("m", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  const watched = deploy("w");
  emit({ events: [mention, mention, event("x"), watched], channelId: channel });
  emit({ events: [deploy("own", { pubkey: bot })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const [first, second] = run.mock.calls.map(([delivery]) => delivery);
  expect(first?.trigger).toEqual({ type: "mention", event: mention });
  expect(second?.trigger).toMatchObject({
    type: "watch",
    event: watched,
    slug: "watch/channel",
    interest: { instructions: "Be brief." },
  });
  expect(first?.channelId).toBe(channel);
  expect(first?.config).toEqual({ reply: "ok" });
});

it("gives each member its teams' roster and instructions, and drops a deleted agent from its teams", async () => {
  const { service, run, emit, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.create({ type: "example/echo", name: "Sib" });
  await expect(
    service.saveTeam({ name: "Crew", instructions: "", members: [other] }),
  ).rejects.toThrow("not an agent");
  const team = await service.saveTeam({
    name: " Crew ",
    instructions: "Echo leads.",
    members: [bot, sibling, bot],
  });
  expect(team).toMatchObject({ name: "Crew", members: [bot, sibling] });
  await service.saveTeam({
    name: "Solo",
    instructions: "",
    members: [sibling],
  });
  expect(service.snapshot().teams.map((saved) => saved.name)).toEqual([
    "Crew",
    "Solo",
  ]);
  emit({
    events: [
      event("m", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const prompt = run.mock.calls[0]?.[0].team ?? "";
  expect(prompt).toContain('"Crew"');
  expect(prompt).toContain(`- Echo (${npubEncode(bot)}), you`);
  expect(prompt).toContain(`- Sib (${npubEncode(sibling)})\n`);
  expect(prompt).toContain("Echo leads.");
  expect(prompt).not.toContain("Solo");

  await service.remove(sibling);
  await vi.waitFor(() =>
    expect(service.snapshot().teams.map((saved) => saved.members)).toEqual([
      [bot],
      [],
    ]),
  );
  expect(storage.getItem("buzz.agents.teams.v1")).not.toContain(sibling);
  await service.removeTeam(team.id);
  expect(service.snapshot().teams.map((saved) => saved.name)).toEqual(["Solo"]);
});

it("leaves the team section out for an agent on no team", () => {
  const agents = [{ pubkey: bot, name: "Echo" }];
  expect(teamPrompt([], agents, bot)).toBe("");
  expect(
    teamPrompt(
      [{ id: "t", name: "Crew", instructions: " ", members: [sibling] }],
      agents,
      bot,
    ),
  ).toBe("");
});

it("keeps handed-off activity local, and pulses typing in the thread until the turn ends", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { service, run, emit, native, activity } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let finish = () => {};
  const turn = new Promise<void>((resolve) => {
    finish = resolve;
  });
  run.mockImplementationOnce(async ({ workingUntil }) => workingUntil(turn));
  const mention = event("m", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  emit({ events: [mention], channelId: channel });
  try {
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    expect(activity.reader.work()[0]?.state).toBe("working");
    expect(native.publish).toHaveBeenCalledWith(bot, {
      kind: 20002,
      content: "",
      tags: [
        ["h", channel],
        ["e", mention.id, "", "reply"],
      ],
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await published(native, 20002)).toHaveLength(2);
    expect(await published(native, 7)).toEqual([]);
    finish();
    await vi.waitFor(() =>
      expect(activity.reader.work()[0]?.state).toBe("done"),
    );
    // Pulses stop with the turn.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await published(native, 20002)).toHaveLength(2);
    expect(await published(native, 7)).toEqual([]);
    expect(await published(native, 5)).toEqual([]);
  } finally {
    finish();
  }
});

it("shows no typing for a mention its runtime ignores", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  run.mockImplementationOnce(async ({ ignored }) => ignored?.());
  emit({
    events: [
      event("m", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
    channelId: channel,
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await settle();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(await published(native, 20002)).toEqual([]);
});

it("wakes on a reply in a thread it started only by a mention or a watch", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  run.mockImplementationOnce(async ({ agent }) => {
    await agent.publish({ kind: 9, content: "hi", tags: [["h", channel]] });
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The publish above returned event p1, which the relay sends back.
  const root = "p1".padEnd(64, "0");
  const reply = (id: string, patch: Partial<RelayEvent> = {}) =>
    event(id, {
      ...patch,
      tags: [["h", channel], ["e", root, "", "reply"], ...(patch.tags ?? [])],
    });
  emit({ events: [event("p1", { pubkey: bot, content: "hi" })] });
  emit({ events: [reply("quiet")] });
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  emit({ events: [reply("watched", { content: "deploy", tags: [DEPLOY] })] });
  emit({ events: [reply("named", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  // Both queued before either ran; mentions go first.
  expect(run.mock.calls.slice(1).map(([{ trigger }]) => trigger.type)).toEqual([
    "mention",
    "watch",
  ]);
});

it("keeps room for mentions however much watch work waits", async () => {
  const { service, run, emit } = await setup({ identities: [echo] });
  await service.save(bot, {
    attentionEnabled: true,
    attention: { ...chat, "watch/channel": null },
  });
  await settle();
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  run.mockImplementationOnce(() => blocked);
  emit({ events: [event("first")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // More watch work than its Interest holds, then a mention.
  emit({
    events: Array.from({ length: 40 }, (_, i) =>
      event(`w${i}x`, { created_at: 101 + i }),
    ),
  });
  emit({
    events: [
      event("named", {
        created_at: 200,
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await settle();
  unblock();
  // The mention is heard next; the watch's Interest kept its own 8.
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(10));
  await settle();
  expect(run).toHaveBeenCalledTimes(10);
  expect(turns(run).slice(0, 3)).toEqual(["watch", "mention", "watch"]);
});

it("runs one turn at a time for an Interest, Interests and mentions beside each other, and frees a lane to the oldest waiting job", async () => {
  const { service, run, emit } = await setup({ identities: [echo] });
  const watch = (interest: string, kind: number) => ({
    type: "event" as const,
    interest_id: interest,
    enabled: true,
    since: 1,
    channels: [channel],
    kinds: [kind],
  });
  await service.save(bot, {
    attentionEnabled: true,
    attention: {
      "watch/channel": null,
      "watch/a": watch("a", 9),
      "watch/b": watch("b", 11),
    },
  });
  await settle();
  const pending = new Map<string, () => void>();
  run.mockImplementation(
    ({ trigger }) =>
      new Promise<void>((resolve) => {
        pending.set(
          trigger.type === "timer" || trigger.type === "catch-up"
            ? trigger.slug
            : trigger.event.content,
          resolve,
        );
      }),
  );
  const working = () => [...pending.keys()].sort();
  const finish = async (content: string) => {
    pending.get(content)?.();
    pending.delete(content);
    await settle();
  };
  emit({
    events: [
      event("a1", { content: "a1", created_at: 101 }),
      event("a2", { content: "a2", created_at: 102 }),
      event("b1", { content: "b1", kind: 11, created_at: 103 }),
      event("b2", { content: "b2", kind: 11, created_at: 104 }),
    ],
  });
  await vi.waitFor(() => expect(working()).toEqual(["a1", "b1"]));
  // A mention runs beside the busy Interests.
  emit({
    events: [
      event("named", {
        content: "named",
        created_at: 105,
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(working()).toEqual(["a1", "b1", "named"]));
  await finish("b1");
  expect(working()).toEqual(["a1", "b2", "named"]);
  await finish("a1");
  expect(working()).toEqual(["a2", "b2", "named"]);
  await finish("a2");
  await finish("b2");
  await finish("named");
  expect(run).toHaveBeenCalledTimes(5);
});

it("runs at most eight Interests at once, and the oldest waiting one next", async () => {
  const { service, run, emit } = await setup({ identities: [echo] });
  const attention: Record<string, object | null> = { "watch/channel": null };
  for (let i = 0; i < 10; i++)
    attention[`watch/w${i}`] = {
      type: "event",
      interest_id: `i${i}`,
      enabled: true,
      since: 1,
      channels: [channel],
      kinds: [20 + i],
    };
  await service.save(bot, {
    attentionEnabled: true,
    attention: attention as never,
  });
  await settle();
  const pending = new Map<string, () => void>();
  run.mockImplementation(
    ({ trigger }) =>
      new Promise<void>((resolve) => {
        if (trigger.type === "watch")
          pending.set(trigger.event.content, resolve);
      }),
  );
  emit({
    events: Array.from({ length: 10 }, (_, i) =>
      event(`e${i}`, { content: `e${i}`, kind: 20 + i, created_at: 101 + i }),
    ),
  });
  await vi.waitFor(() => expect(pending.size).toBe(8));
  await settle();
  expect(run).toHaveBeenCalledTimes(8);
  pending.get("e3")?.();
  pending.delete("e3");
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(9));
  expect(pending.has("e8")).toBe(true);
  expect(pending.has("e9")).toBe(false);
});

it("passes the model and effort its owner asked for, and no other", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const asked = (id: string, pubkey: string, ...tags: string[][]) =>
    event(id, { pubkey, tags: [["h", channel], ["p", bot], ...tags] });
  emit({
    events: [
      asked("owner", viewer, ["effort", bot, "high"]),
      asked("stranger", other, ["effort", bot, "high"], ["model", bot, "deep"]),
      asked("unlisted", viewer, ["effort", bot, "max"]),
      asked("elsewhere", viewer, ["effort", sibling, "high"]),
      asked("model", viewer, ["model", bot, "deep"], ["effort", bot, "max"]),
      asked("mismatch", viewer, ["model", bot, "deep"], ["effort", bot, "low"]),
      asked("unknown", viewer, ["model", bot, "gone"], ["effort", bot, "low"]),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(7));
  expect(
    run.mock.calls.map(([{ model, effort }]) => ({ model, effort })),
  ).toEqual([
    { model: undefined, effort: "high" },
    { model: undefined, effort: undefined },
    { model: undefined, effort: undefined },
    { model: undefined, effort: undefined },
    // An effort counts only for the model the run uses.
    { model: "deep", effort: "max" },
    { model: "deep", effort: undefined },
    { model: undefined, effort: "low" },
  ]);
});

it("keeps the in-flight run and the queue across edits; each job reads the agent as it starts", async () => {
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  let held: Delivery<Config> | undefined;
  run.mockImplementationOnce(
    (delivery) =>
      new Promise<void>((resolve) => {
        held = delivery;
        release = resolve;
      }),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(held).toBeDefined());
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, { name: "Echo two", config: { reply: "new" } });
  await service.save(bot, {
    attention: { "watch/channel": null },
  });
  expect(held?.signal.aborted).toBe(false);
  await held?.agent.publish({ kind: 7, content: "+" });
  expect(native.publish).toHaveBeenLastCalledWith(bot, {
    kind: 7,
    content: "+",
  });
  release();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const queued = run.mock.calls[1]?.[0];
  expect(queued?.config).toEqual({ reply: "new" });
  expect(queued?.agent.name).toBe("Echo two");
});

it("starts each run from the start resolver, local with no synced revisions", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { config: { reply: "local" } });
  emit({ events: [event("1", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0]).toMatchObject({
    config: { reply: "local" },
    revisions: [],
  });
});

describe("a type without synced settings", () => {
  const subject: Subject = {
    owner: viewer,
    community: "https://relay.example.test",
    subject: bot,
    channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
    type: "buzz.agent.settings",
  };
  /** This device once had a synced settings revision of the agent. */
  const withHistory = () => {
    const storage = memoryStorage();
    const store = new AgentConfigStore(storage);
    const head = finalizeEvent(
      {
        kind: 45010,
        created_at: 1,
        content: JSON.stringify({
          version: 1,
          agentType: "example/echo",
          settings: {},
        }),
        tags: [["op", "create"]],
      },
      generateSecretKey(),
    ) as RelayEvent;
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: head,
    });
    expect(store.hadVersion(subject)).toBe(true);
    return storage;
  };
  const fixtures: { ctx: Context }[] = [];
  afterEach(async () => {
    for (const f of fixtures.splice(0)) await f.ctx.fiber.dispose();
  });
  const mention = async (mode: Mode, storage = memoryStorage()) => {
    const f = await setup({
      storage,
      binding: () => ({ settings: { mode, subject } }),
    });
    await f.service.create({ type: "example/echo", name: "Echo" });
    await f.service.save(bot, { config: { reply: "local" } });
    f.emit({
      events: [
        event("1", {
          tags: [
            ["h", channel],
            ["p", bot],
          ],
        }),
      ],
      channelId: channel,
    });
    fixtures.push(f);
    return f;
  };
  const refused = async (f: Awaited<ReturnType<typeof mention>>) => {
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]).toMatchObject({
        state: "error",
        error: "This agent type has no synced settings",
      }),
    );
    expect(f.run).not.toHaveBeenCalled();
  };

  it.each(["local", "migrating"] as const)(
    "starts from the local config when settings are %s with no synced revision",
    async (mode) => {
      const f = await mention(mode);
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      expect(f.run.mock.calls[0]?.[0]).toMatchObject({
        config: { reply: "local" },
        revisions: [],
      });
    },
  );

  it("refuses to start when settings are explicitly synced", async () => {
    await refused(await mention("synced"));
  });

  it.each(["local", "migrating"] as const)(
    "refuses to start when settings are %s but this device had a synced revision",
    async (mode) => {
      await refused(await mention(mode, withHistory()));
    },
  );
});

it("keeps queued work across a disconnect and runs it once on reconnect", async () => {
  const { service, run, emit, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  connect(false);
  expect(service.find(bot)).toBeUndefined();
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, { config: { reply: "new" } });
  connect(true);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].config).toEqual({ reply: "new" });
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
});

it("aborts the in-flight run, and drops what is queued, when the agent is removed", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let held: Delivery<Config> | undefined;
  run.mockImplementationOnce(
    (delivery) =>
      new Promise(() => {
        held = delivery;
      }),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(held).toBeDefined());
  await service.remove(bot);
  expect(held?.signal.aborted).toBe(true);
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
});

it("drops its events while another copy of the app holds the agent, and runs once it holds it", async () => {
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  native.claim.mockResolvedValue(false);
  emit({ events: [event("1", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalledWith(bot));
  await settle();
  expect(run).not.toHaveBeenCalled();
  native.claim.mockResolvedValue(true);
  const second = event("2", { tags: [["p", bot]] });
  emit({ events: [second] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toEqual({
    type: "mention",
    event: second,
  });
  // When the claim itself fails, it answers rather than stay silent.
  native.claim.mockRejectedValue(new Error("unreadable"));
  emit({ events: [event("3", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
});

it("lets another copy of the app run an agent it cannot run", async () => {
  vi.useFakeTimers();
  const { service, run, emit, native, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  emit({ events: [event("1", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(native.release).not.toHaveBeenCalled();
  connect(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(native.release).toHaveBeenCalledTimes(1);
  expect(native.release).toHaveBeenCalledWith(bot);
  connect(true);
  native.claim.mockClear();
  emit({ events: [event("2", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(native.claim).toHaveBeenCalledWith(bot);
});

it("claims an agent as it comes into view, and releases it as it leaves, without waiting for a tick", async () => {
  const { service, native, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalledWith(bot));
  connect(false);
  await vi.waitFor(() => expect(native.release).toHaveBeenCalledWith(bot));
  native.claim.mockClear();
  connect(true);
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalledWith(bot));
});

it("keeps running an agent while another community is selected, and gives it only its community's events", async () => {
  const { service, run, emit, second, select } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  select(second.origin);
  expect(service.find(bot)).toBeUndefined();
  expect(service.snapshot().running.map((agent) => agent.pubkey)).toEqual([
    bot,
  ]);
  expect(service.relay(bot)?.snapshot().origin).toBe(
    "https://relay.example.test",
  );
  second.emit({ events: [event("2", { tags: [["p", bot]] })] });
  const mention = event("1", { tags: [["p", bot]] });
  emit({ events: [mention] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toEqual({
    type: "mention",
    event: mention,
  });
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
});

it("connects an agent's community at start without selecting it", async () => {
  const { service, run, second, communities } = await setup({
    identities: [
      {
        pubkey: bot,
        relay: "wss://other.example.test",
        owner: viewer,
        type: "example/echo",
        name: "Echo",
        deleted: false,
      },
    ],
  });
  expect(communities.open).toHaveBeenCalledWith("https://other.example.test");
  expect(service.find(bot)).toBeUndefined();
  second.emit({ events: [event("1", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
});

it("opens no community for an agent list that arrives after it stopped", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const client = fakeCommunities(
    fakeRelay(),
    fakeRelay("https://other.example.test"),
  );
  client.select(null);
  const native = fakeNative();
  let list!: (identities: AgentIdentity[]) => void;
  native.list.mockReturnValueOnce(
    new Promise((resolve) => {
      list = resolve;
    }),
  );
  const service = new AgentsService(
    ctx,
    client.communities,
    native,
    memoryStorage(),
  );
  await vi.waitFor(() => expect(list).toBeDefined());
  await ctx.fiber.dispose();
  list([
    {
      pubkey: bot,
      relay: "wss://other.example.test",
      owner: viewer,
      type: "example/echo",
      name: "Echo",
      deleted: false,
    },
  ]);
  await settle();
  expect(client.communities.open).not.toHaveBeenCalled();
  expect(service.snapshot().running).toEqual([]);
});

it("keeps an agent running while its community reconnects, and stops it on disconnect or leave", async () => {
  const { service, connect, reconnecting, leave } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const running = () => service.snapshot().running.map((agent) => agent.pubkey);
  reconnecting();
  expect(service.find(bot)).toBeUndefined();
  expect(running()).toEqual([bot]);
  connect(false);
  expect(running()).toEqual([]);
  connect(true);
  expect(running()).toEqual([bot]);
  leave("https://relay.example.test");
  expect(running()).toEqual([]);
  expect(service.relay(bot)).toBeUndefined();
});

it("tries a failed unselected community again every so often, and leaves the selected one's Retry to the viewer", async () => {
  vi.useFakeTimers();
  const { service, relay, fail, second, select } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  fail();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(relay.retry).not.toHaveBeenCalled();
  select(second.origin);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(relay.retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(relay.retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(relay.retry).toHaveBeenCalledTimes(2);
});

it("is not woken by reactions, deletions or encrypted DMs", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const ownMessage = "p1".padEnd(64, "0");
  emit({
    events: [
      event("react", {
        kind: 7,
        tags: [
          ["e", ownMessage],
          ["p", bot],
        ],
      }),
      event("delete", { kind: 5, tags: [["e", ownMessage]] }),
      event("dm", { kind: 4, tags: [["p", bot]] }),
    ],
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({ type: "mention" });
});

it("wakes on an unmentioned message only in a one-to-one DM it is in", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const inDm = (id: string, patch: Partial<RelayEvent> = {}) =>
    event(id, {
      pubkey: viewer,
      ...patch,
      tags: [["h", dm], ...(patch.tags ?? [])],
    });
  const auth = ["auth", viewer, "", "f".repeat(128)];
  emit({
    events: [
      // Not conversation with it: a stream message, an unmentioned group DM,
      // DMs it is not known to be in, an edit, a reaction, its own message and
      // a sibling agent's.
      event("stream"),
      event("group", { tags: [["h", groupDm]] }),
      event("others", { tags: [["h", "dm-others"]] }),
      event("unknown", { tags: [["h", "dm-unknown"]] }),
      inDm("edit", { kind: 40003 }),
      inDm("like", { kind: 7, tags: [["e", "x".repeat(64)]] }),
      inDm("own", { pubkey: bot }),
      inDm("sibling", { pubkey: sibling, tags: [auth] }),
    ],
  });
  await settle();
  expect(run).not.toHaveBeenCalled();
  // Naming someone else in a one-to-one DM still talks to the agent; a group
  // DM wakes it only through the mention.
  emit({ events: [inDm("hello")] });
  emit({
    events: [inDm("more", { tags: [["e", "x".repeat(64), "", "reply"]] })],
  });
  emit({ events: [inDm("about", { tags: [["p", other]] })] });
  emit({
    events: [
      event("asked", {
        tags: [
          ["h", groupDm],
          ["p", bot],
        ],
      }),
    ],
  });
  // The runner keys on the channel, not the author: someone outside the roster
  // is queued too, and the runtime's `fromOwner` is what turns them away.
  emit({ events: [inDm("stranger", { pubkey: other })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5));
  expect(run.mock.calls.map(([{ trigger }]) => trigger)).toMatchObject([
    { type: "mention", event: { id: "hello".padEnd(64, "0") } },
    { type: "mention", event: { id: "more".padEnd(64, "0") } },
    { type: "mention", event: { id: "about".padEnd(64, "0") } },
    { type: "mention", event: { id: "asked".padEnd(64, "0") } },
    { type: "mention", event: { id: "stranger".padEnd(64, "0") } },
  ]);
});

it("wakes on another of the owner's agents only when it names the agent", async () => {
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.create({ type: "example/echo", name: "Sibling" });
  run.mockImplementation(async ({ agent, trigger }) => {
    if (trigger.type === "timer") return;
    await agent.publish({ kind: 9, content: "hi" });
  });
  emit({
    events: [
      event("start", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const echoMessage = (await published(native, 9))[0]?.id;
  const auth = ["auth", viewer, "", "f".repeat(128)];
  // The sibling replies to Echo's message without naming it, and says "deploy",
  // which Echo's watch matches. Neither wakes Echo: two agents replying to each
  // other would otherwise never stop.
  emit({
    events: [
      event("reply", {
        pubkey: sibling,
        content: "deploy",
        tags: [["h", channel], ["e", echoMessage], DEPLOY, auth],
      }),
    ],
  });
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  // Naming Echo wakes it, even in reply to Echo's own message.
  emit({
    events: [
      event("callback", {
        pubkey: sibling,
        tags: [["h", channel], ["e", echoMessage], ["p", bot], auth],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    type: "mention",
    event: { pubkey: sibling },
  });
});

it("answers the owner and agents the owner attested, nobody else", async () => {
  const secret = schnorr.utils.randomSecretKey();
  const owner = bytesToHex(schnorr.getPublicKey(secret));
  const agent = bytesToHex(
    schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
  );
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent}:`)
    .digest();
  const auth = ["auth", owner, "", bytesToHex(schnorr.sign(digest, secret))];
  const from = (pubkey: string, tags: string[][] = []) =>
    event("gate", { pubkey, tags });
  expect(await fromOwner(from(owner), owner)).toBe(true);
  expect(await fromOwner(from(agent, [auth]), owner)).toBe(true);
  expect(await fromOwner(from(agent), owner)).toBe(false);
  // Another key cannot borrow the agent's attestation, nor claim an owner.
  expect(await fromOwner(from(other, [auth]), owner)).toBe(false);
  expect(
    await fromOwner(from(agent, [["auth", owner, "", "0".repeat(128)]]), owner),
  ).toBe(false);
});

it("accepts relay workflow delegation only from this agent's owner", async () => {
  const relay = keypair();
  const workflow = { authority: relay.pubkey, agent: bot };
  const prompt = eventDto(
    signed(relay, {
      kind: 9,
      content: "@bot work",
      tags: [
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", viewer],
        ["buzz:workflow-mention", bot],
      ],
    }),
  );
  expect(await fromOwner(prompt, viewer, workflow)).toBe(true);
  expect(await fromOwner(prompt, other, workflow)).toBe(false);
  expect(await fromOwner(prompt, viewer)).toBe(false);
});

it("changes an agent's type between turns, carrying what the new type adopts", async () => {
  const { service, native, run, emit, ctx, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const attention = service.find(bot)?.attention;
  await service.save(bot, { config: { reply: "Triage." } });
  const other = vi.fn<(delivery: Delivery<{ prompt: string }>) => void>();
  ctx
    .extend({ pluginOwner: Object.freeze({ id: "other", revision: "one" }) })
    .agents.register<{ prompt: string; model: string }>({
      id: "relay",
      title: "Relay",
      defaults: () => ({ config: { prompt: "", model: "small" } }),
      adopt: (carry, saved) => ({
        ...saved,
        prompt: carry.instructions ?? saved.prompt,
      }),
      carry: ({ prompt }) => ({ instructions: prompt }),
      describeMigration: () => [
        { id: "model", label: "Model", isOverride: false },
        {
          id: "sessions",
          label: "Sessions",
          isOverride: false,
          unchangedKey: "thread",
        },
        {
          id: "equivalent",
          label: "Equivalent setting",
          isOverride: false,
          unchangedKey: "same",
        },
        { id: "destination", label: "Destination only", isOverride: false },
      ],
      run: other,
    });
  // Not while a turn, or the work it handed off, is still going.
  let finish = () => {};
  run.mockImplementationOnce(async ({ workingUntil }) =>
    workingUntil(new Promise<void>((resolve) => (finish = resolve))),
  );
  const mention = (id: string) =>
    event(id, {
      tags: [
        ["h", channel],
        ["p", bot],
      ],
    });
  emit({ events: [mention("m1")], channelId: channel });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(service.previewRetype(bot, "other/relay")).toEqual({
    config: { prompt: "Triage.", model: "small" },
    moved: ["instructions"],
    dropped: ["workspace"],
    settings: [
      { id: "model", label: "Model", outcome: "reset" },
      { id: "thinking", label: "Thinking", outcome: "dropped" },
      { id: "sessions", label: "Sessions", outcome: "reset" },
    ],
  });
  expect(native.setType).not.toHaveBeenCalled();
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "Echo is answering",
  );
  expect(native.setType).not.toHaveBeenCalled();
  finish();
  await settle();
  vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
    throw new Error("QuotaExceededError");
  });
  await expect(
    service.retype(bot, "other/relay", {
      config: { prompt: "Reviewed target", model: "large" },
    }),
  ).rejects.toThrow("QuotaExceededError");
  expect(native.setType.mock.calls).toEqual([
    [bot, "other/relay"],
    [bot, "example/echo"],
  ]);
  expect(service.find(bot)).toMatchObject({
    type: "example/echo",
    config: { reply: "Triage." },
  });
  native.setType.mockClear();
  native.claim.mockResolvedValueOnce(false);
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "Another copy of Buzz is running this agent",
  );
  expect(native.setType).not.toHaveBeenCalled();
  native.claim.mockRejectedValueOnce(new Error("claim unavailable"));
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "claim unavailable",
  );
  expect(native.setType).not.toHaveBeenCalled();
  let continueType = () => {};
  const typeGate = new Promise<void>((resolve) => (continueType = resolve));
  const persistType = native.setType.getMockImplementation();
  native.setType.mockImplementationOnce(async (...args) => {
    await typeGate;
    return persistType?.(...args);
  });
  // The workspace has no place in the new type, so it stays behind.
  const changing = service.retype(bot, "other/relay", {
    config: { prompt: "Reviewed target", model: "large" },
  });
  await vi.waitFor(() => expect(native.setType).toHaveBeenCalledOnce());
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "provider is already changing",
  );
  await expect(
    service.save(bot, { config: { reply: "Lost edit" } }),
  ).rejects.toThrow("provider is already changing");
  await service.save(bot, { attentionEnabled: true });
  emit({ events: [mention("m2")], channelId: channel });
  await settle();
  expect(other).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
  continueType();
  await expect(changing).resolves.toEqual(["workspace"]);
  expect(native.setType).toHaveBeenCalledWith(bot, "other/relay");
  expect(service.find(bot)).toMatchObject({
    type: "other/relay",
    config: { prompt: "Reviewed target", model: "large" },
    attention,
    attentionEnabled: true,
  });
  // The new type answers from now on.
  await vi.waitFor(() => expect(other).toHaveBeenCalledOnce());
  expect(other.mock.calls[0]?.[0].config).toEqual({
    prompt: "Reviewed target",
    model: "large",
  });
  expect(run).toHaveBeenCalledOnce();
  // Its own type, or one not available, changes nothing.
  expect(await service.retype(bot, "other/relay")).toEqual([]);
  await expect(service.retype(bot, "missing/type")).rejects.toThrow(
    "not available",
  );
  expect(native.setType).toHaveBeenCalledOnce();
});

it("sets and clears a picture through native, and publishes it", async () => {
  const { service, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  native.publishProfile.mockClear();
  const url = "https://relay.example/media/abc";
  await service.save(bot, { picture: url });
  expect(native.setPicture).toHaveBeenCalledWith(bot, url);
  expect(service.find(bot)?.picture).toBe(url);
  expect(native.publishProfile).toHaveBeenCalledWith(bot);
  // An unchanged picture is not saved again; an empty one clears it.
  await service.save(bot, { picture: url });
  expect(native.setPicture).toHaveBeenCalledOnce();
  await service.save(bot, { picture: "" });
  expect(native.setPicture).toHaveBeenLastCalledWith(bot, null);
  expect(service.find(bot)?.picture).toBeUndefined();
});

it("renames through native, and publishes profiles again on rename and reconnect", async () => {
  const { service, native, connect } = await setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  native.publishProfile.mockRejectedValueOnce(new Error("offline"));
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  // An unpublished profile only warns; the agent exists either way.
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(service.find(bot)).toEqual(agent);
  warn.mockRestore();
  native.publishProfile.mockClear();
  await service.save(bot, { name: " Echo Two " });
  expect(native.rename).toHaveBeenCalledWith(bot, "Echo Two");
  expect(service.find(bot)?.name).toBe("Echo Two");
  expect(native.publishProfile).toHaveBeenCalledWith(bot);
  // An unchanged name is not saved again.
  await service.save(bot, { name: "Echo Two", config: { reply: "new" } });
  expect(native.rename).toHaveBeenCalledOnce();
  connect(false);
  connect(true);
  expect(native.publishProfile).toHaveBeenCalledTimes(2);
});

it("retries a failed profile when the live connection recovers in the same session", async () => {
  const { service, native, recover } = await setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  native.publishProfile.mockRejectedValueOnce(new Error("offline"));
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  expect(native.publishProfile).toHaveBeenCalledTimes(1);
  recover();
  expect(native.publishProfile).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});

it("refreshes an agent's cached core memory when its community connects or its socket recovers in the same session", async () => {
  const { service, session, memories, recover, connect } = await setup();
  const read = vi.mocked(session.agentMemories.read);
  await service.create({ type: "example/echo", name: "Echo" });
  memories.set(bot, "one");
  // A device that has never read it waits once.
  await expect(service.core(bot)).resolves.toBe("one");
  const reads = read.mock.calls.length;
  // Changed elsewhere while the socket was down; the session is kept.
  memories.set(bot, "two");
  recover();
  expect(read).toHaveBeenCalledTimes(reads + 1);
  await settle();
  await expect(service.core(bot)).resolves.toBe("two");
  expect(read).toHaveBeenCalledTimes(reads + 1);
  // A new session refreshes it too.
  memories.set(bot, "three");
  connect(false);
  connect(true);
  await settle();
  await expect(service.core(bot)).resolves.toBe("three");
  expect(read).toHaveBeenCalledTimes(reads + 2);
});

it("keeps core memory an agent writes through its handle, and refreshes it when the run and its handed-off work end", async () => {
  const { service, session, memories, run, emit } = await setup();
  const read = vi.mocked(session.agentMemories.read);
  await service.create({ type: "example/echo", name: "Echo" });
  memories.set(bot, "before");
  await expect(service.core(bot)).resolves.toBe("before");
  let finish = () => {};
  run.mockImplementationOnce(async ({ agent, workingUntil }) => {
    await agent.remember("core", "written", 0);
    workingUntil(new Promise<void>((resolve) => (finish = resolve)));
  });
  emit({
    events: [
      event("m1", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
    channelId: channel,
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  await settle();
  const reads = read.mock.calls.length;
  // The write is the next start's at once, with no read.
  await expect(service.core(bot)).resolves.toBe("written");
  expect(read).toHaveBeenCalledTimes(reads);
  // Not until the handed-off work ends.
  memories.set(bot, "after");
  await settle();
  expect(read).toHaveBeenCalledTimes(reads);
  finish();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(reads + 1));
  await settle();
  await expect(service.core(bot)).resolves.toBe("after");
});

it("refreshes core memory when a standalone turn ends, without holding the next one on that read", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const memory: (string | null | undefined)[] = [];
  let service!: AgentsService;
  const f = await setup({
    runOnce: async () => {
      memory.push(await service.core(bot));
      return { ok: true };
    },
  });
  service = f.service;
  const read = vi.mocked(f.session.agentMemories.read);
  await service.create({ type: "example/echo", name: "Echo" });
  f.memories.set(bot, "one");
  await expect(service.core(bot)).resolves.toBe("one");
  await service.save(bot, { attentionEnabled: true });
  const timer = (armed: number) =>
    ({
      type: "timer",
      interest_id: "default",
      prompt: "tick",
      enabled: true,
      interval_secs: 60,
      armed_at: armed,
      max_occurrences: 1,
      expires_at: null,
    }) as const;
  // The first turn's refresh is held: the second starts on the cached text.
  let release = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            entries: [
              { slug: "core", body: "two", eventId: "e", createdAt: 0 },
            ],
            partial: false,
          });
      }),
  );
  await service.save(bot, {
    attention: { "watch/a": timer(1_000), "watch/b": timer(1_000) },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(memory).toEqual(["one", "one"]));
  release();
  await vi.advanceTimersByTimeAsync(0);
  await expect(service.core(bot)).resolves.toBe("two");
});

it("never writes decrypted core memory to storage, so a rebuilt service reads it again", async () => {
  const storage = memoryStorage();
  const written: string[] = [];
  const setItem = storage.setItem.bind(storage);
  vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
    written.push(`${key}=${value}`);
    setItem(key, value);
  });
  const leaked = () =>
    written.filter((entry) => /secret-(read|written|refreshed)/.test(entry));
  const first = await setup({ storage });
  const read = vi.mocked(first.session.agentMemories.read);
  await first.service.create({ type: "example/echo", name: "Echo" });
  // A read.
  first.memories.set(bot, "secret-read");
  await expect(first.service.core(bot)).resolves.toBe("secret-read");
  // A successful write through the agent's handle.
  first.run.mockImplementationOnce(async ({ agent }) => {
    await agent.remember("core", "secret-written", 0);
  });
  first.emit({
    events: [
      event("m1", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
    channelId: channel,
  });
  await vi.waitFor(() => expect(first.run).toHaveBeenCalledOnce());
  await settle();
  // A refresh.
  first.memories.set(bot, "secret-refreshed");
  first.recover();
  await settle();
  await expect(first.service.core(bot)).resolves.toBe("secret-refreshed");
  expect(read.mock.calls.length).toBeGreaterThan(0);
  expect(leaked()).toEqual([]);
  // A service rebuilt on the same storage starts empty and reads core again.
  const second = await setup({ storage });
  const reread = vi.mocked(second.session.agentMemories.read);
  await second.service.create({ type: "example/echo", name: "Echo" });
  second.memories.set(bot, "after restart");
  await expect(second.service.core(bot)).resolves.toBe("after restart");
  expect(reread).toHaveBeenCalled();
  expect(leaked()).toEqual([]);
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i) as string;
    expect(storage.getItem(key)).not.toMatch(/secret-/);
  }
});

it("stops refreshing core memory for a community once it is left", async () => {
  const { service, session, recover, leave, select } = await setup();
  const read = vi.mocked(session.agentMemories.read);
  await service.create({ type: "example/echo", name: "Echo" });
  await service.core(bot);
  select("https://other.example.test");
  leave("https://relay.example.test");
  const reads = read.mock.calls.length;
  recover();
  await settle();
  expect(read).toHaveBeenCalledTimes(reads);
});

it("keeps a Delete that fails partway listed and stopped, deletes nothing, and retries nothing", async () => {
  const { service, native, archives, recover } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  leaveChannels.mockRejectedValueOnce(new Error("offline"));
  await expect(service.remove(bot)).rejects.toThrow(UNFINISHED);
  warn.mockRestore();
  expect(service.find(bot)?.deleting).toBe(true);
  expect(native.remove).not.toHaveBeenCalled();
  // Reconnecting retries nothing.
  recover();
  await service.refresh();
  await settle();
  expect(leaveChannels).toHaveBeenCalledTimes(1);
  expect(archives.request).not.toHaveBeenCalled();
  expect(records.remove).not.toHaveBeenCalled();
  expect(steps).toEqual(["stop"]);
  // Delete again runs it all again.
  await service.remove(bot);
  expect(steps).toEqual([
    "stop",
    "stop",
    "channels",
    "archive",
    "record",
    "key",
    "forget",
  ]);
  expect(service.find(bot)).toBeUndefined();
});

it("shows an agent whose settings could not be saved with its type's defaults", async () => {
  const storage = memoryStorage();
  const { service } = await setup({ storage });
  vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
    throw new Error("QuotaExceededError");
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await service.create({ type: "example/echo", name: "Echo" });
  warn.mockRestore();
  expect(storage.getItem("buzz.agents.v1") ?? "").not.toContain(bot);
  expect(service.find(bot)).toMatchObject({ config: { reply: "ok" } });
  expect(Object.keys(service.find(bot)?.attention ?? {})).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  // The next save stores them.
  await service.save(bot, { config: { reply: "saved" } });
  expect(storage.getItem("buzz.agents.v1")).toContain(bot);
});

it("saves nothing when native create fails", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  native.create.mockRejectedValueOnce(new Error("Credential store refused"));
  await expect(
    service.create({ type: "example/echo", name: "Echo" }),
  ).rejects.toThrow("Credential store refused");
  expect(service.snapshot().agents).toEqual([]);
  expect(storage.getItem("buzz.agents.v1")).toBeNull();
});

it("creates an agent with the config it was given, not its type's defaults, and sets its picture", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  const picture = "https://relay.example/media/pack.png";
  const agent = await service.create({
    type: "example/echo",
    name: " Echo ",
    picture,
    config: { reply: "chosen" },
  });
  expect(native.create).toHaveBeenCalledWith(
    "https://relay.example.test",
    viewer,
    "example/echo",
    "Echo",
  );
  expect(native.setPicture).toHaveBeenCalledExactlyOnceWith(bot, picture);
  expect(agent).toMatchObject({ pubkey: bot, name: "Echo", picture });
  expect(agent.config).toEqual({ reply: "chosen" });
  expect(service.find(bot)).toMatchObject({
    picture,
    config: { reply: "chosen" },
  });
  // Everything but the config still starts from the type's defaults.
  expect(Object.keys(service.find(bot)?.attention ?? {})).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  expect(storage.getItem("buzz.agents.v1")).toContain("chosen");
});

it("keeps a new agent whose picture could not be set", async () => {
  const { service, native } = await setup();
  native.setPicture.mockRejectedValueOnce(new Error("Could not write"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = await service.create({
    type: "example/echo",
    name: "Echo",
    picture: "https://relay.example/media/pack.png",
    config: { reply: "chosen" },
  });
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("picture was not saved"),
    expect.any(Error),
  );
  warn.mockRestore();
  expect(agent).toMatchObject({
    pubkey: bot,
    name: "Echo",
    config: { reply: "chosen" },
  });
  expect(service.find(bot)).toMatchObject({ config: { reply: "chosen" } });
  expect(agent.picture).toBeUndefined();
  expect(service.find(bot)?.picture).toBeUndefined();
  expect(service.snapshot().agents.map((item) => item.pubkey)).toEqual([bot]);
});

it("sets no picture and uses the type's defaults for a new agent given neither", async () => {
  const { service, native } = await setup();
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  expect(native.setPicture).not.toHaveBeenCalled();
  expect(agent.config).toEqual({ reply: "ok" });
  expect(service.find(bot)).toMatchObject({ config: { reply: "ok" } });
});

it("refuses a blank name before making anything", async () => {
  const { service, native } = await setup();
  await expect(
    service.create({ type: "example/echo", name: "   " }),
  ).rejects.toThrow("Name the agent");
  expect(native.create).not.toHaveBeenCalled();
  expect(service.snapshot().agents).toEqual([]);
});

it("returns the created agent after the community changes mid-create", async () => {
  const { service, native, connect } = await setup();
  const create = native.create.getMockImplementation();
  if (!create) throw new Error("The fake creates agents");
  native.create.mockImplementationOnce(async (...input) => {
    connect(false);
    return create(...input);
  });
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  expect(agent).toMatchObject({ pubkey: bot, name: "Echo" });
  expect(service.find(bot)).toBeUndefined();
});

it("forgets records whose key is gone when identities load", async () => {
  const storage = memoryStorage();
  storage.setItem(
    "buzz.agents.v1",
    JSON.stringify({
      version: 1,
      agents: {
        [bot]: { pubkey: bot, attention: {}, config: {} },
        [sibling]: { pubkey: sibling, attention: {}, config: {} },
      },
    }),
  );
  const { service } = await setup({
    storage,
    identities: [
      {
        pubkey: bot,
        relay: "wss://relay.example.test",
        owner: viewer,
        type: "example/echo",
        name: "Echo",
        deleted: false,
      },
    ],
  });
  expect(service.snapshot().agents.map((agent) => agent.name)).toEqual([
    "Echo",
  ]);
  expect(storage.getItem("buzz.agents.v1")).not.toContain(sibling);
});

it("keeps an agent created while identities are still loading", async () => {
  const storage = memoryStorage();
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const native = fakeNative();
  let release: (value: AgentIdentity[]) => void = () => {};
  native.list.mockImplementationOnce(
    () => new Promise<AgentIdentity[]>((resolve) => (release = resolve)),
  );
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    native,
    storage,
  );
  ctx
    .extend({ pluginOwner: Object.freeze({ id: "example", revision: "one" }) })
    .agents.register<Config>({
      id: "echo",
      title: "Echo",
      defaults: () => ({ config: { reply: "ok" } }),
    });
  await vi.waitFor(() => expect(native.list).toHaveBeenCalled());
  await service.create({ type: "example/echo", name: "Echo" });
  release([]);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  expect(service.find(bot)?.name).toBe("Echo");
  expect(storage.getItem("buzz.agents.v1")).toContain(bot);
});

it("reads the list again on refresh and clears the error a failed read left", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const identity = {
    pubkey: bot,
    relay: "wss://relay.example.test",
    owner: viewer,
    type: "example/echo",
    name: "Echo",
    picture: "https://cdn.example.test/echo.png",
    deleted: false,
  };
  const native = fakeNative([identity]);
  native.list.mockRejectedValueOnce(
    new Error("Could not read saved agent identities"),
  );
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    native,
    memoryStorage(),
  );
  await vi.waitFor(() =>
    expect(service.local()).toEqual({
      status: "error",
      agents: [],
      error: "Could not read saved agent identities",
    }),
  );
  await service.refresh();
  expect(native.list).toHaveBeenCalledTimes(2);
  expect(service.local()).toEqual({
    status: "ready",
    agents: [
      {
        pubkey: bot,
        name: "Echo",
        relayUrl: "wss://relay.example.test",
        owner: viewer,
        picture: "https://cdn.example.test/echo.png",
      },
    ],
  });
  expect(service.snapshot().error).toBeUndefined();
});

it("fires a due timer once, then again an interval after it ran", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/tick": {
        type: "timer",
        interest_id: "default",
        prompt: "check in",
        enabled: true,
        interval_secs: 60,
        armed_at: 1_000,
        max_occurrences: 2,
        expires_at: null,
      },
      // Armed long ago with no run state: what was due counts as used, so it
      // neither fires at once nor ever (both of its runs are spent).
      "watch/stale": {
        type: "timer",
        interest_id: "default",
        prompt: "stale",
        enabled: true,
        interval_secs: 60,
        armed_at: 0,
        max_occurrences: 2,
        expires_at: null,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(55_000);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    type: "timer",
    slug: "watch/tick",
    interest: { instructions: "Be brief." },
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  // The last allowed occurrence says so, as Janet's final wake does.
  expect(run.mock.calls.map(([{ trigger }]) => trigger)).toMatchObject([
    { spent: false },
    { spent: true },
  ]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run).toHaveBeenCalledTimes(2);
  // Its run state lives in the agent's record and goes when the timer does.
  const stored = () =>
    JSON.parse(storage.getItem("buzz.agents.v1") ?? "{}").agents[bot];
  expect(stored().timers["watch/tick"]).toMatchObject({ used: 2 });
  expect(stored().timers["watch/stale"]).toMatchObject({ used: 16 });
  await service.save(bot, { attention: { "watch/tick": null } });
  expect(Object.keys(stored().timers)).toEqual(["watch/stale"]);
});

it("runs a type's wakes as standalone turns, one at a time per Interest, and drops waiting ones when attention goes off", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const releases: (() => void)[] = [];
  const turns: { key: string; prompt?: string | undefined }[] = [];
  const { service, run } = await setup({
    runOnce: async (turn) => {
      const entry: (typeof turns)[number] = { key: turn.key };
      turns.push(entry);
      entry.prompt = await turn.prompt();
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    },
  });
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const timer = (prompt: string) =>
    ({
      type: "timer",
      interest_id: "default",
      prompt,
      enabled: true,
      interval_secs: 60,
      armed_at: 1_000,
      max_occurrences: 1,
      expires_at: null,
    }) as const;
  await service.save(bot, {
    attention: {
      "watch/first": timer("one"),
      "watch/second": timer("two"),
      "watch/third": timer("three"),
    },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  // The host owns the lane: one turn runs for the Interest, the other waits,
  // and `run` (mentions only) is never asked.
  await vi.waitFor(() => expect(turns[0]?.prompt).toBeDefined());
  await vi.advanceTimersByTimeAsync(1_000);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.key).toMatch(/^timer\/\w+$/);
  expect(turns[0]?.prompt).toContain("Timer: ");
  expect(turns[0]?.prompt).toContain("Be brief.");
  expect(run).not.toHaveBeenCalled();
  // Its end frees the lane for the next.
  releases[0]?.();
  await vi.waitFor(() => expect(turns[1]?.prompt).toBeDefined());
  expect(turns).toHaveLength(2);
  // Turned off, the waiting turn is dropped; the running one finishes.
  await service.save(bot, { attentionEnabled: false });
  releases[1]?.();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(turns).toHaveLength(2);
  expect(run).not.toHaveBeenCalled();
});

it("aborts a standalone turn's signal at its deadline, counted from when it starts", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const reasons: unknown[] = [];
  let started: number | undefined;
  const { service } = await setup({
    // A harness still waiting for readiness when the deadline passes.
    runOnce: (turn) =>
      new Promise((resolve) => {
        started = Date.now();
        turn.signal.addEventListener("abort", () => {
          reasons.push(turn.signal.reason);
          resolve({ ok: false, error: String(turn.signal.reason) });
        });
      }),
  });
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/held": {
        type: "timer",
        interest_id: "default",
        prompt: "one",
        enabled: true,
        interval_secs: 60,
        armed_at: 1_000,
        max_occurrences: 1,
        expires_at: null,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  if (started === undefined) throw new Error("Expected the turn to start");
  await vi.advanceTimersByTimeAsync(
    started + STANDALONE_DEADLINE_MS - 1_000 - Date.now(),
  );
  expect(reasons).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reasons).toHaveLength(1);
  expect(String(reasons[0])).toContain("deadline");
});

it("keeps at most one occurrence of a timer waiting, and never runs one removed meanwhile", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const timer = (prompt: string) =>
    ({
      type: "timer",
      interest_id: "default",
      prompt,
      enabled: true,
      interval_secs: 1,
      armed_at: 1_000,
      max_occurrences: null,
      expires_at: null,
    }) as const;
  await service.save(bot, {
    attention: { "watch/kept": timer("kept"), "watch/removed": timer("gone") },
  });
  let release: () => void = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  // The first run holds the runner across many intervals of both timers.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  await service.save(bot, { attention: { "watch/removed": null } });
  release();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(0);
  const slugs = run.mock.calls.map(([{ trigger }]) =>
    trigger.type === "timer" ? trigger.slug : trigger.type,
  );
  expect(slugs).toEqual(["watch/kept", "watch/kept"]);
});

it("gives each due timer a turn when one's runs outlast its interval", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const timer = (prompt: string) =>
    ({
      type: "timer",
      interest_id: "default",
      prompt,
      enabled: true,
      interval_secs: 1,
      armed_at: 1_000,
      max_occurrences: null,
      expires_at: null,
    }) as const;
  await service.save(bot, {
    attention: { "watch/slow": timer("slow"), "watch/other": timer("other") },
  });
  // Every run takes three intervals, so the first timer is always due again.
  run.mockImplementation(
    () => new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  const slugs = run.mock.calls.map(([{ trigger }]) =>
    trigger.type === "timer" ? trigger.slug : trigger.type,
  );
  expect(slugs.slice(0, 4)).toEqual([
    "watch/slow",
    "watch/other",
    "watch/slow",
    "watch/other",
  ]);
});

it("runs waiting events before a due timer, so a busy timer cannot starve them", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/tick": {
        type: "timer",
        interest_id: "default",
        prompt: "tick",
        enabled: true,
        interval_secs: 1,
        armed_at: 1_000,
        max_occurrences: null,
        expires_at: null,
      },
    },
  });
  let release: () => void = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.advanceTimersByTimeAsync(5_000);
  release();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(run.mock.calls.map(([{ trigger }]) => trigger.type)).toEqual([
    "timer",
    "mention",
    "timer",
  ]);
});

it("stops it first, and deletes its key only after it left its channels and was archived", async () => {
  const { service, native, storage, archives } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.remove(bot);
  expect(steps).toEqual([
    "stop",
    "channels",
    "archive",
    "record",
    "key",
    "forget",
  ]);
  expect(service.snapshot().agents).toEqual([]);
  expect(storage.getItem("buzz.agents.v1")).not.toContain(bot);
  expect(leaveChannels).toHaveBeenCalledWith(
    expect.objectContaining({ archives }),
    bot,
    expect.any(AbortSignal),
  );
  expect(archives.request).toHaveBeenCalledWith(
    "archive",
    bot,
    expect.any(AbortSignal),
  );
  expect(await native.list()).toEqual([]);
});

it("joins a Delete already running instead of starting another", async () => {
  const { service, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  leaveChannels.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const first = service.remove(bot);
  await vi.waitFor(() => expect(leaveChannels).toHaveBeenCalledOnce());
  const second = service.remove(bot);
  release();
  await Promise.all([first, second]);
  expect(native.beginDelete).toHaveBeenCalledOnce();
  expect(leaveChannels).toHaveBeenCalledOnce();
  expect(native.forget).toHaveBeenCalledOnce();
});

it("keeps an unfinished Delete stopped after a relaunch, and finishes it only when Delete runs again", async () => {
  const storage = memoryStorage();
  const first = await setup({ storage });
  await first.service.create({ type: "example/echo", name: "Echo" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  leaveChannels.mockRejectedValueOnce(new Error("offline"));
  await expect(first.service.remove(bot)).rejects.toThrow(UNFINISHED);
  warn.mockRestore();
  const identities = await first.native.list();
  const { service, run, emit, native } = await setup({ storage, identities });
  expect(service.find(bot)).toMatchObject({ name: "Echo", deleting: true });
  emit({ events: [event("1", { tags: [["p", bot]] })] });
  await settle();
  expect(run).not.toHaveBeenCalled();
  expect(native.remove).not.toHaveBeenCalled();
  expect(records.remove).not.toHaveBeenCalled();
  await service.remove(bot);
  expect(native.forget).toHaveBeenCalledWith(bot);
  expect(service.find(bot)).toBeUndefined();
});

it("after a relaunch, only drops the record and row of an agent left deleted", async () => {
  const { service, native, archives } = await setup({
    identities: [{ ...here(bot), name: "Echo", deleted: true }],
  });
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
  expect(steps).toEqual(["record", "forget"]);
  expect(leaveChannels).not.toHaveBeenCalled();
  expect(archives.consent).not.toHaveBeenCalled();
  expect(archives.request).not.toHaveBeenCalled();
  expect(await native.list()).toEqual([]);
  expect(service.snapshot().agents).toEqual([]);
});

it("refuses a re-import while a Delete runs, from this copy of the app or another sharing its agents", async () => {
  const identities: AgentIdentity[] = [];
  const { service } = await setup({ identities });
  // Another copy of the app, reading and writing the same native agents.
  const { service: otherCopy } = await setup({ identities });
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  leaveChannels.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const removing = service.remove(bot);
  await vi.waitFor(() => expect(leaveChannels).toHaveBeenCalledOnce());
  for (const copy of [service, otherCopy])
    await expect(
      copy.port({ source: "harness", pubkey: bot, type: "example/echo" }),
    ).rejects.toThrow("That agent is already here");
  release();
  await removing;
  expect(identities).toEqual([]);
  // Once deleted it can come back, with nothing left to remove it again.
  steps.length = 0;
  const { agent } = await otherCopy.port({
    source: "harness",
    pubkey: bot,
    type: "example/echo",
  });
  expect(agent.pubkey).toBe(bot);
  await settle();
  expect(steps).toEqual([]);
});

it("stops an old-order row's record deletion once a re-import takes the agent back", async () => {
  // Deleted by an earlier build, which erased the key first.
  let reached = false;
  records.remove.mockImplementationOnce(
    (_, __, ___, ____, fence: AbortSignal) =>
      new Promise<never>((_, reject) => {
        reached = true;
        fence.addEventListener("abort", () => reject(fence.reason));
      }),
  );
  const { service, native } = await setup({
    identities: [{ ...here(bot), name: "Echo", deleted: true }],
  });
  await vi.waitFor(() => expect(reached).toBe(true));
  const { agent } = await service.port({
    source: "harness",
    pubkey: bot,
    type: "example/echo",
  });
  expect(agent.pubkey).toBe(bot);
  await settle();
  expect(records.remove).toHaveBeenCalledOnce();
  expect(native.forget).not.toHaveBeenCalled();
  expect(
    (await native.list()).find((item) => item.pubkey === bot)?.deleted,
  ).toBe(false);
});

it("offers a retry when import could not check archive state, and retries without re-importing", async () => {
  const { service, archives, native } = await setup();
  archives.archived.add(sibling);
  archives.refresh.mockRejectedValueOnce(new Error("offline"));
  const { notes } = await service.port({
    source: "installed",
    pubkey: sibling,
    type: "example/echo",
  });
  expect(notes).toEqual([
    "Couldn't check whether Older is archived in this community. Retry from its settings.",
  ]);
  expect(service.find(sibling)?.archiveUnchecked).toBe(true);
  // Reconnecting does not retry it behind the user's back.
  archives.request.mockClear();
  await service.refresh();
  expect(archives.request).not.toHaveBeenCalled();
  await expect(service.unarchive(sibling)).resolves.toBeUndefined();
  expect(archives.archived.has(sibling)).toBe(false);
  expect(service.find(sibling)?.archiveUnchecked).toBeUndefined();
  expect(native.port).toHaveBeenCalledOnce();
});

it("treats a community without archives as nothing to unarchive", async () => {
  const { service, archives } = await setup();
  archives.unavailable = true;
  archives.unknown = true;
  const { notes } = await service.port({
    source: "installed",
    pubkey: sibling,
    type: "example/echo",
  });
  expect(notes).toEqual([]);
  expect(archives.request).not.toHaveBeenCalled();
  expect(service.find(sibling)?.archiveUnchecked).toBeUndefined();
});

it("keeps the archive Retry across a restart until a check confirms it", async () => {
  const storage = memoryStorage();
  const first = await setup({ storage });
  first.archives.archived.add(sibling);
  first.archives.refresh.mockRejectedValueOnce(new Error("offline"));
  await first.service.port({
    source: "installed",
    pubkey: sibling,
    type: "example/echo",
  });
  const identities = await first.native.list();
  const { service, archives } = await setup({ storage, identities });
  archives.archived.add(sibling);
  expect(service.find(sibling)?.archiveUnchecked).toBe(true);
  archives.refresh.mockRejectedValueOnce(new Error("offline"));
  await expect(service.unarchive(sibling)).rejects.toThrow("offline");
  expect(service.find(sibling)?.archiveUnchecked).toBe(true);
  await expect(service.unarchive(sibling)).resolves.toBeUndefined();
  expect(service.find(sibling)?.archiveUnchecked).toBeUndefined();
  const { service: relaunched } = await setup({ storage, identities });
  expect(relaunched.find(sibling)?.archiveUnchecked).toBeUndefined();
});

it.each([
  ["while it reads archive state", "refresh"],
  ["while it checks consent", "consent"],
] as const)(
  "keeps the archive Retry when the session closes %s, on import and on Retry",
  async (_, step) => {
    const { service, archives } = await setup();
    archives.archived.add(sibling);
    // A disposed session ends its reads without an answer and refuses consent.
    const close = () => {
      archives.unknown = true;
    };
    const closing = () =>
      step === "refresh"
        ? archives.refresh.mockImplementationOnce(async () => close())
        : archives.consent.mockImplementationOnce(async () => {
            close();
            return null;
          });
    closing();
    const { notes } = await service.port({
      source: "installed",
      pubkey: sibling,
      type: "example/echo",
    });
    expect(notes).toEqual([
      "Couldn't check whether Older is archived in this community. Retry from its settings.",
    ]);
    expect(service.find(sibling)?.archiveUnchecked).toBe(true);
    archives.unknown = false;
    closing();
    await expect(service.unarchive(sibling)).rejects.toThrow();
    expect(service.find(sibling)?.archiveUnchecked).toBe(true);
    expect(archives.request).not.toHaveBeenCalled();
    archives.unknown = false;
    await expect(service.unarchive(sibling)).resolves.toBeUndefined();
    expect(archives.archived.has(sibling)).toBe(false);
    expect(service.find(sibling)?.archiveUnchecked).toBeUndefined();
  },
);

it("forgets an agent with no owner-attested profile without archiving it", async () => {
  const { service, native, archives } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  archives.consent.mockResolvedValueOnce(null);
  await service.remove(bot);
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
  expect(archives.request).not.toHaveBeenCalled();
});

it("deletes nothing outside the agent's community, and leaves it stopped for Delete to run again", async () => {
  const { service, native, archives, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  connect(false);
  await expect(service.remove(bot)).rejects.toThrow(
    `${UNFINISHED} Its community isn't connected.`,
  );
  expect(native.remove).not.toHaveBeenCalled();
  connect(true);
  await settle();
  expect(service.find(bot)?.deleting).toBe(true);
  expect(leaveChannels).not.toHaveBeenCalled();
  expect(archives.request).not.toHaveBeenCalled();
  expect(native.forget).not.toHaveBeenCalled();
});

it("does not archive later when the session closes while its Delete reads archive state", async () => {
  const { service, native, archives, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  archives.refresh.mockImplementationOnce(async () => {
    // A closed session's read ends without an answer.
    archives.unknown = true;
    connect(false);
  });
  await expect(service.remove(bot)).rejects.toThrow(UNFINISHED);
  warn.mockRestore();
  expect(await native.list()).toMatchObject([
    { pubkey: bot, deleted: false, deleting: true },
  ]);
  archives.unknown = false;
  connect(true);
  await settle();
  expect(archives.request).not.toHaveBeenCalled();
  expect(native.remove).not.toHaveBeenCalled();
  expect(native.forget).not.toHaveBeenCalled();
});

it("runs once per matching watch, and passes a classifier watch it cannot classify", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/classified": {
        type: "event",
        interest_id: "missing",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
        classifier: {
          questions: {
            deploy: {
              question: "Is it about a deploy?",
              true: "It is",
              false: "It is not",
              threshold: 0.5,
            },
          },
        },
      },
    },
  });
  emit({ events: [deploy("w")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const triggers = run.mock.calls.map(([delivery]) => delivery.trigger);
  expect(triggers).toEqual([
    expect.objectContaining({ slug: "watch/channel" }),
    expect.objectContaining({
      slug: "watch/classified",
      classifier: { outcome: "not-run", reason: expect.any(String) },
    }),
  ]);
  // Its Interest does not exist, so it arrives without instructions.
  expect(triggers[1]).not.toHaveProperty("interest");
});

/** A native classifier whose answers the test sets. */
function fakeJev(configured = true) {
  let key = configured;
  const jev = {
    status: vi.fn(async () => key),
    setKey: vi.fn(async (_: string) => {
      key = true;
    }),
    clearKey: vi.fn(async () => {
      key = false;
    }),
    classify: vi.fn<ClassifierNative["classify"]>(async () => ({
      outcome: "answered",
      answers: { deploy: { type: "noul", noul: 0.9 } },
    })),
  };
  return jev;
}
async function classifiedAgent(jev: ReturnType<typeof fakeJev>) {
  const harness = await setup({ jev });
  await harness.service.create({ type: "example/echo", name: "Echo" });
  await harness.service.save(bot, {
    attentionEnabled: true,
    attention: {
      "watch/channel": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: [channel],
        kinds: [9],
        classifier: {
          questions: {
            deploy: { question: "Is it about a deploy?", threshold: 0.5 },
          },
        },
      },
    },
  });
  return harness;
}

it("runs a watch's classifier after its selectors and passes the event with each answer", async () => {
  const jev = fakeJev();
  const { service, run, emit } = await classifiedAgent(jev);
  await vi.waitFor(() => expect(service.classifier()).toBe("available"));
  emit({ events: [event("w", { content: "shipping v2" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    slug: "watch/channel",
    classifier: {
      outcome: "passed",
      model: "jev-1.13.0",
      answers: { deploy: { probability: 0.9, threshold: 0.5, pass: true } },
      policy: "deploy",
    },
  });
  const [state, questions] = jev.classify.mock.calls[0] ?? [];
  expect(state).toMatchObject({
    event: { id: expect.stringMatching(/^w0+$/), content: "shipping v2" },
    author: { role: "other" },
    context: { channel: expect.any(Object), thread: { is_reply: false } },
  });
  expect(questions).toMatchObject({
    deploy: {
      type: "noul",
      instructions: { question: "Is it about a deploy?" },
      criteria: { true: expect.any(String), false: expect.any(String) },
    },
  });
});

it("drops an event every answer rejects, and does not classify an event the selectors reject", async () => {
  const jev = fakeJev();
  jev.classify.mockResolvedValue({
    outcome: "answered",
    answers: { deploy: { type: "noul", noul: 0.2 } },
  });
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w", { content: "lunch?" })] });
  emit({ events: [event("x", { kind: 7 })] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledOnce());
  await settle();
  expect(run).not.toHaveBeenCalled();
});

it("passes the event when the classifier fails, and says why", async () => {
  const jev = fakeJev();
  jev.classify
    .mockResolvedValueOnce({ outcome: "failed", reason: "timeout" })
    .mockResolvedValueOnce({ outcome: "answered", answers: {} })
    .mockRejectedValueOnce(new Error("ipc"));
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("a"), event("b"), event("c")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(
    run.mock.calls
      .map(([delivery]) => delivery.trigger)
      .map((t) => (t.type === "watch" ? t.classifier : undefined)),
  ).toEqual([
    { outcome: "failed", reason: "timeout" },
    { outcome: "failed", reason: "invalid_response" },
    { outcome: "failed", reason: "service_error" },
  ]);
});

it("without a key the classifier does not run and the turn is told so", async () => {
  const jev = fakeJev(false);
  const { service, run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).not.toHaveBeenCalled();
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "not-run" },
  });
  expect(service.classifier()).toBe("unavailable");
});

it("a key set or cleared takes effect at once, and one removed elsewhere is noticed", async () => {
  const jev = fakeJev(false);
  const { service, run, emit } = await classifiedAgent(jev);
  await service.setClassifierKey("tk");
  expect(jev.setKey).toHaveBeenCalledWith("tk");
  expect(service.classifier()).toBe("available");
  expect(service.snapshot().classifier).toBe("available");
  await service.clearClassifierKey();
  expect(service.classifier()).toBe("unavailable");
  await service.setClassifierKey("tk");
  jev.classify.mockResolvedValueOnce({
    outcome: "failed",
    reason: "missing_credentials",
  });
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "not-run" },
  });
  expect(service.classifier()).toBe("unavailable");
});

it("shows a key it cannot read as unreadable, and one the service refuses as refused", async () => {
  const jev = fakeJev();
  jev.status.mockRejectedValueOnce(new Error("locked"));
  const { service, run, emit } = await classifiedAgent(jev);
  await vi.waitFor(() =>
    expect(service.snapshot().classifierKey).toBe("unreadable"),
  );
  // Unreadable is not missing: native is still asked, and its answer shows
  // the key is saved.
  emit({ events: [event("a")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).toHaveBeenCalledOnce();
  expect(service.snapshot().classifierKey).toBe("saved");
  jev.classify.mockResolvedValueOnce({
    outcome: "failed",
    reason: "unauthorized",
  });
  emit({ events: [event("b")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    classifier: { outcome: "failed", reason: "unauthorized" },
  });
  expect(service.snapshot().classifierKey).toBe("refused");
  expect(service.classifier()).toBe("available");
  // Another failure does not say whether the key was accepted.
  jev.classify.mockResolvedValueOnce({ outcome: "failed", reason: "timeout" });
  emit({ events: [event("c")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(service.snapshot().classifierKey).toBe("refused");
});

it("does not run an event classified against a classifier changed since", async () => {
  const jev = fakeJev();
  let answer!: (
    value: Awaited<ReturnType<ClassifierNative["classify"]>>,
  ) => void;
  jev.classify.mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const { service, run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledOnce());
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  if (watch?.type !== "event") throw new Error("no watch");
  await service.save(bot, {
    attention: {
      "watch/channel": {
        ...watch,
        classifier: { questions: { deploy: { question: "Is it urgent?" } } },
      },
    },
  });
  answer({
    outcome: "answered",
    answers: { deploy: { type: "noul", noul: 1 } },
  });
  await settle();
  await settle();
  expect(run).not.toHaveBeenCalled();
});

type Answer = Awaited<ReturnType<ClassifierNative["classify"]>>;
const yes: Answer = {
  outcome: "answered",
  answers: { deploy: { type: "noul", noul: 0.9 } },
};

it("queues classified events in arrival order, whichever answer comes first", async () => {
  const jev = fakeJev();
  let first!: (value: Answer) => void;
  jev.classify
    .mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
    .mockResolvedValueOnce(yes);
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("a"), event("b")] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledTimes(2));
  await settle();
  expect(run).not.toHaveBeenCalled();
  first(yes);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(
    run.mock.calls.map(([delivery]) =>
      delivery.trigger.type === "watch" ? delivery.trigger.event.id[0] : "",
    ),
  ).toEqual(["a", "b"]);
});

it("an event heard before the saved key's status is read waits for it, then is classified", async () => {
  const jev = fakeJev();
  let known!: (value: boolean) => void;
  jev.status.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (known = resolve)),
  );
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await settle();
  expect(run).not.toHaveBeenCalled();
  known(true);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "passed" },
  });
});

it("a failed read of the key's status does not stop a saved key from classifying", async () => {
  const jev = fakeJev();
  jev.status.mockRejectedValueOnce(new Error("The Keychain is locked"));
  const { service, run, emit } = await classifiedAgent(jev);
  expect(service.classifier()).toBe("unavailable");
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "passed" },
  });
  expect(service.classifier()).toBe("available");
});

it("keeps a key removed while a call that used it ran shown as missing", async () => {
  const jev = fakeJev();
  let answer!: (value: Answer) => void;
  jev.classify.mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const { service, run, emit } = await classifiedAgent(jev);
  await vi.waitFor(() =>
    expect(service.snapshot().classifierKey).toBe("saved"),
  );
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledOnce());
  await service.clearClassifierKey();
  answer(yes);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(service.snapshot().classifierKey).toBe("missing");
  expect(service.classifier()).toBe("unavailable");
});

it("keeps a key saved while an old key's call ran shown as saved, though the old one was refused", async () => {
  const jev = fakeJev();
  let answer!: (value: Answer) => void;
  jev.classify.mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const { service, run, emit } = await classifiedAgent(jev);
  await vi.waitFor(() =>
    expect(service.snapshot().classifierKey).toBe("saved"),
  );
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledOnce());
  await service.setClassifierKey("new");
  answer({ outcome: "failed", reason: "unauthorized" });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(service.snapshot().classifierKey).toBe("saved");
});

it("keeps a key saved before the first status read answers shown as saved", async () => {
  const jev = fakeJev(false);
  let known!: (value: boolean) => void;
  jev.status.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (known = resolve)),
  );
  const { service } = await classifiedAgent(jev);
  await service.setClassifierKey("tk");
  known(false);
  await settle();
  expect(service.snapshot().classifierKey).toBe("saved");
});

it("classifies a watched event of an agent whose community is not selected", async () => {
  const jev = fakeJev();
  const { service, run, emit, second, select } = await classifiedAgent(jev);
  await vi.waitFor(() => expect(service.classifier()).toBe("available"));
  select(second.origin);
  expect(service.find(bot)).toBeUndefined();
  emit({ events: [event("w", { content: "shipping v2" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    slug: "watch/channel",
    classifier: { outcome: "passed" },
  });
});

it("classifies a reply without its parent when the parent lookup does not answer", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const jev = fakeJev();
    const { native, run, emit } = await classifiedAgent(jev);
    native.query.mockImplementation(() => new Promise(() => {}));
    emit({
      events: [
        event("r", {
          tags: [
            ["h", channel],
            ["e", "b".repeat(64), "", "reply"],
          ],
        }),
      ],
    });
    await vi.waitFor(() => expect(native.query).toHaveBeenCalled());
    expect(jev.classify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const [state] = jev.classify.mock.calls[0] ?? [];
    expect((state as { context: { thread: unknown } }).context.thread).toEqual({
      is_reply: true,
      parent: null,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("sends nothing to the classifier for a watch stopped while its event waited", async () => {
  const jev = fakeJev();
  let known!: (value: boolean) => void;
  jev.status.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (known = resolve)),
  );
  const { service, run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await settle();
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  if (watch?.type !== "event") throw new Error("no watch");
  await service.save(bot, {
    attention: { "watch/channel": { ...watch, enabled: false } },
  });
  known(true);
  await settle();
  await settle();
  expect(jev.classify).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("a copy of the app that does not hold the agent sends nothing to the classifier", async () => {
  const jev = fakeJev();
  const { native, run, emit } = await classifiedAgent(jev);
  native.claim.mockResolvedValue(false);
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalled());
  await settle();
  await settle();
  expect(jev.classify).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("gives the classifier Buzz's thread parent: the marked reply, in any case; a lone root is no reply", async () => {
  const jev = fakeJev();
  const { native, emit } = await classifiedAgent(jev);
  const parent = "A".repeat(64);
  emit({
    events: [
      event("r", {
        tags: [
          ["h", channel],
          ["e", "b".repeat(64), "", "root"],
        ],
      }),
      event("p", {
        tags: [
          ["h", channel],
          ["e", "b".repeat(64), "", "root"],
          ["e", "c".repeat(64), "", "reply"],
          ["e", parent, "", "reply"],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledTimes(2));
  const states = jev.classify.mock.calls.map(
    ([state]) => state as { context: { thread: { is_reply: boolean } } },
  );
  expect(states.map((state) => state.context.thread.is_reply)).toEqual([
    false,
    true,
  ]);
  expect(native.query).toHaveBeenCalledOnce();
  expect(native.query).toHaveBeenCalledWith(bot, [
    { ids: [parent.toLowerCase()], limit: 1 },
  ]);
});

it("keeps encrypted DMs and reactions to its own messages away from watches", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/everything": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
      },
    },
  });
  run.mockImplementationOnce(async ({ agent }) => {
    await agent.publish({ kind: 9, content: "hi", tags: [["h", channel]] });
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  emit({
    events: [
      event("dm", { kind: 4, tags: [["p", bot]] }),
      // p1 is what the run above published.
      event("like", { kind: 7, tags: [["e", "p1".padEnd(64, "0")]] }),
      event("note", { kind: 1 }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    type: "watch",
    slug: "watch/everything",
    event: { id: "note".padEnd(64, "0") },
  });
});

const everything = {
  "watch/everything": {
    type: "event",
    interest_id: "default",
    enabled: true,
    since: 1,
    channels: "all",
    kinds: [],
  },
} as const;
const woke = (run: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  run.mock.calls.map(([input]) =>
    (input as { trigger: { event: RelayEvent } }).trigger.event.id.replace(
      /0+$/,
      "",
    ),
  );

it("delivers what a reconnect replays since the agent started listening, once", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  const now = Math.floor(Date.now() / 1000);
  emit({ events: [event("live", { created_at: now })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The subscription comes back and sends its recent history again: the one
  // already heard, one missed while it was down, and one from before.
  emit({
    replay: true,
    events: [
      event("live", { created_at: now }),
      event("missed", { created_at: now + 1 }),
      event("before", { created_at: now - 600 }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await settle();
  expect(woke(run)).toEqual(["live", "missed"]);
});

it("still knows a quiet channel's event when a reconnect replays it after busy traffic elsewhere", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  const now = Math.floor(Date.now() / 1000);
  emit({ events: [event("quiet", { created_at: now })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // More events than the shared seen set holds, all in another channel.
  emit({
    events: Array.from({ length: 2_100 }, (_, index) =>
      event(`busy${index}x`, { created_at: now, tags: [["h", "private"]] }),
    ),
  });
  emit({ replay: true, events: [event("quiet", { created_at: now })] });
  // A later event runs after anything the replay queued.
  emit({ events: [event("after", { created_at: now })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await settle();
  expect(woke(run)).toEqual(["quiet", "after"]);
});

it("delivers a replay of more matching events than the rate limit takes at once, each once", async () => {
  vi.useFakeTimers({ now: 1_000_000_000 });
  try {
    const { service, run, emit } = await setup();
    await service.create({ type: "example/echo", name: "Echo" });
    await service.save(bot, { attentionEnabled: true, attention: everything });
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 80 }, (_, index) => `m${index}x`);
    // A three-minute drop: live, these would have spread over three windows.
    emit({
      replay: true,
      events: ids.map((id, index) =>
        event(id, { created_at: now + 1 + Math.floor(index / 30) }),
      ),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls.length).toBeLessThanOrEqual(60);
    expect(run.mock.calls.length).toBeGreaterThan(0);
    // The rest wait for the next rate window, and a second replay of the
    // same history wakes nothing again.
    emit({
      replay: true,
      events: ids.map((id) => event(id, { created_at: now + 1 })),
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(woke(run).sort()).toEqual(
      ids.map((id) => id.replace(/0+$/, "")).sort(),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("leaves a replay past its backlog unseen, so a later replay delivers it", async () => {
  vi.useFakeTimers({ now: 1_000_000_000 });
  try {
    const { service, run, emit } = await setup();
    await service.create({ type: "example/echo", name: "Echo" });
    await service.save(bot, { attentionEnabled: true, attention: everything });
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 520 }, (_, index) => `b${index}x`);
    const replay = () =>
      emit({
        replay: true,
        events: ids.map((id) => event(id, { created_at: now + 1 })),
      });
    replay();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run.mock.calls.length).toBe(512);
    replay();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(new Set(woke(run)).size).toBe(520);
    expect(run.mock.calls.length).toBe(520);
  } finally {
    vi.useRealTimers();
  }
});

it("holds a watched event until the relay confirms its channel's saved roster", async () => {
  const { service, run, emit, confirm } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  emit({
    events: [
      event("kept", { tags: [["h", "saved"]] }),
      event("dropped", { tags: [["h", "saved"]] }),
    ],
  });
  await settle();
  expect(run).not.toHaveBeenCalled();
  // Confirmed with the agent still in it: both wake it, each once.
  confirm("saved", [viewer, bot]);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  confirm("saved", [viewer, bot]);
  await settle();
  expect(woke(run)).toEqual(["kept", "dropped"]);
});

it("delivers a held replay of more events than the agent takes at once when its roster is confirmed", async () => {
  vi.useFakeTimers({ now: 1_000_000_000 });
  try {
    const { service, run, emit, confirm } = await setup();
    await service.create({ type: "example/echo", name: "Echo" });
    await service.save(bot, { attentionEnabled: true, attention: everything });
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 80 }, (_, index) => `h${index}x`);
    const replay = () =>
      emit({
        replay: true,
        events: ids.map((id) =>
          event(id, { created_at: now + 1, tags: [["h", "saved"]] }),
        ),
      });
    replay();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).not.toHaveBeenCalled();
    // More than the queue takes at once: the rest wait for room.
    confirm("saved", [viewer, bot]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls.length).toBeGreaterThan(0);
    expect(run.mock.calls.length).toBeLessThan(80);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    replay();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(woke(run).sort()).toEqual(
      ids.map((id) => id.replace(/0+$/, "")).sort(),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("drops a held event when the confirmed roster no longer has the agent", async () => {
  const { service, run, emit, confirm } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  emit({ events: [event("removed", { tags: [["h", "saved"]] })] });
  await settle();
  confirm("saved", [viewer]);
  confirm("saved", [viewer, bot]);
  await settle();
  expect(run).not.toHaveBeenCalled();
});

const echo = {
  pubkey: bot,
  relay: "wss://relay.example.test",
  owner: viewer,
  type: "example/echo",
  name: "Echo",
  deleted: false,
};
const chat = {
  "watch/chat": {
    type: "event",
    interest_id: "default",
    enabled: true,
    since: 1,
    channels: [channel],
    kinds: [9],
  },
} as const;
const author = keypair();
/** A message in `channel` the relay signed and stored. */
const posted = (content: string, created_at: number) =>
  eventDto(message(author, channel, content, created_at));
/** What each run heard, a catch-up's events in order. */
const heard = (run: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  run.mock.calls.flatMap(([input]) => {
    const { trigger } = input as { trigger: Trigger };
    return trigger.type === "catch-up"
      ? trigger.events.map(({ event }) => event.content)
      : trigger.type === "timer"
        ? []
        : [trigger.event.content];
  });
/** Each run's trigger type, and how many events a catch-up had. */
const turns = (run: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  run.mock.calls.map(([input]) => {
    const { trigger } = input as { trigger: Trigger };
    return trigger.type === "catch-up"
      ? `catch-up ${trigger.slug} ${trigger.events.length}${trigger.skipped ? " skipped" : ""}`
      : trigger.type;
  });
const catchUpReads = (session: RelaySession) =>
  vi
    .mocked(session.read)
    .mock.calls.map(([filters]) => filters[0] as ReadFilter)
    .filter((filter) => filter.kinds?.includes(9));
const nowSeconds = () => Math.floor(Date.now() / 1000);

it("catches a kind 9 watch up on what it missed, oldest first in batches, and not again after a restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const first = await setup({ storage, identities: [echo] });
    vi.setSystemTime(start * 1000);
    // Only this watch: the type's default one reads the channel too.
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    // Missed while the socket was down.
    vi.setSystemTime((start + 200) * 1000);
    for (let i = 0; i < 70; i++)
      first.history.push(posted(`m${i}`, start + 100 + i));
    first.recover();
    await vi.waitFor(() => expect(first.run).toHaveBeenCalledTimes(2));
    await settle();
    // The whole window is read first, then heard strictly oldest first, a
    // batch of 64 to a turn.
    expect(turns(first.run)).toEqual([
      "catch-up watch/chat 64",
      "catch-up watch/chat 6",
    ]);
    expect(heard(first.run)).toEqual(
      Array.from({ length: 70 }, (_, i) => `m${i}`),
    );
    // Pages of 16 newest first, down to an empty one that ends the window.
    const reads = catchUpReads(first.session);
    expect(reads).toHaveLength(6);
    expect(reads[0]).toEqual({
      kinds: [9],
      "#h": [channel],
      since: start + 1,
      until: start + 200,
      limit: 16,
    });
    expect(reads[1]).toMatchObject({
      until: start + 154,
      before_id: expect.any(String),
    });
    expect(reads[5]).toMatchObject({ until: start + 100 });
    first.connect(false);
    // Started again a minute later, it reads only what came after.
    vi.setSystemTime((start + 260) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      history: [...first.history, posted("late", start + 230)],
    });
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(second.run)).toEqual(["late"]);
    expect(catchUpReads(second.session)[0]).toMatchObject({
      since: start + 201,
      until: start + 260,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("bounds a catch-up turn by its messages' size, and sends a larger one alone", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    await service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    vi.setSystemTime((now + 200) * 1000);
    history.push(posted("x".repeat(100_000), now + 100));
    for (let i = 0; i < 3; i++)
      history.push(posted(`${i}`.repeat(30_000), now + 101 + i));
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    await settle();
    // 64 Ki characters a turn: two of 30,000 fit, a third does not.
    expect(turns(run)).toEqual([
      "catch-up watch/chat 1",
      "catch-up watch/chat 2",
      "catch-up watch/chat 1",
    ]);
    expect(heard(run).map((content) => content[0])).toEqual([
      "x",
      "0",
      "1",
      "2",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("takes the next page's cursor from the relay's events, not a local one older than them", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, session, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    await service.save(bot, { attentionEnabled: true, attention: chat });
    await settle();
    // Missed while the socket was down.
    vi.setSystemTime((now + 200) * 1000);
    for (let i = 0; i < 20; i++) history.push(posted(`m${i}`, now + 100 + i));
    const read = vi.mocked(session.read);
    const original = read.getMockImplementation() as NonNullable<
      ReturnType<typeof read.getMockImplementation>
    >;
    let first = true;
    read.mockImplementation(async (filters, options) => {
      const events = await original(filters, options);
      if (!filters[0]?.kinds?.includes(9) || !first) return events;
      first = false;
      // The owner's message not yet sent, from before the relay's oldest.
      return [...events, { ...posted("unsent", now + 50) }];
    });
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(run)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  } finally {
    vi.useRealTimers();
  }
});

it("holds a watch's live events while it catches up, then hears them oldest first", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, session, history, emit, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    await service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    vi.setSystemTime((now + 200) * 1000);
    for (let i = 0; i < 16; i++) history.push(posted(`m${i}`, now + 100 + i));
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    run.mockImplementation(() => blocked);
    const read = vi.mocked(session.read);
    const original = read.getMockImplementation() as NonNullable<
      ReturnType<typeof read.getMockImplementation>
    >;
    let first = true;
    read.mockImplementation(async (filters, options) => {
      if (filters[0]?.kinds?.includes(9) && first) {
        first = false;
        // Live traffic arrives while the page is on its way, newest first.
        emit({
          events: Array.from({ length: 20 }, (_, i) =>
            event(`live${i}x`, { created_at: now + 219 - i }),
          ),
        });
      }
      return original(filters, options);
    });
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    await settle();
    unblock();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(21), {
      timeout: 5_000,
    });
    // What it missed comes first, whole; then what it heard live meanwhile.
    expect(turns(run)).toEqual([
      "catch-up watch/chat 16",
      ...Array<string>(20).fill("watch"),
    ]);
    expect(heard(run)).toEqual([
      ...Array.from({ length: 16 }, (_, i) => `m${i}`),
      ...Array.from({ length: 20 }, (_, i) => `hello live${19 - i}x`),
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("starts catch-up again when its watch is edited while a page is being read", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, session, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    // Only this watch: the type's default one would wake for "deploy" too.
    await service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    vi.setSystemTime((now + 60) * 1000);
    const other = keypair();
    history.push(
      eventDto(message(other, channel, "before", now + 10)),
      posted("deploy", now + 20),
    );
    const read = vi.mocked(session.read);
    const original = read.getMockImplementation() as NonNullable<
      ReturnType<typeof read.getMockImplementation>
    >;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    read.mockImplementation(async (filters, options) => {
      if (filters[0]?.kinds?.includes(9) && first) {
        first = false;
        await held;
      }
      return original(filters, options);
    });
    recover();
    await vi.waitFor(() => expect(catchUpReads(session)).toHaveLength(1));
    await service.save(bot, {
      attention: {
        "watch/chat": {
          ...chat["watch/chat"],
          exclude_authors: [other.pubkey],
        },
      },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // The page read for the old watch wakes nothing when it comes back.
    release();
    await settle();
    await settle();
    expect(heard(run)).toEqual(["deploy"]);
  } finally {
    vi.useRealTimers();
  }
});

it("wakes nothing for what came before a watch was first caught up, as after an upgrade", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const first = await setup({ storage, identities: [echo] });
    vi.setSystemTime(start * 1000);
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    first.connect(false);
    // As a build from before catch-up leaves it: the watch, and no progress.
    storage.removeItem(CATCH_UP_KEY);
    vi.setSystemTime((start + 60) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      history: [posted("before", start - 600), posted("offline", start + 30)],
    });
    await settle();
    await settle();
    expect(second.run).not.toHaveBeenCalled();
    expect(catchUpReads(second.session)).toEqual([]);
    // From then on, it catches up on what it misses.
    vi.setSystemTime((start + 120) * 1000);
    second.history.push(posted("missed", start + 90));
    second.recover();
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(second.run)).toEqual(["missed"]);
  } finally {
    vi.useRealTimers();
  }
});

it("gives each matching watch one catch-up turn with the events it matched", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    vi.setSystemTime(now * 1000);
    const watch = chat["watch/chat"];
    await service.save(bot, {
      attentionEnabled: true,
      attention: {
        "watch/channel": null,
        "watch/chat": watch,
        "watch/chat2": watch,
        "watch/chat3": watch,
      },
    });
    await settle();
    vi.setSystemTime((now + 60) * 1000);
    // One page: 16 events, and three jobs for each of them.
    for (let i = 0; i < 16; i++) history.push(posted(`m${i}`, now + 10 + i));
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    await settle();
    // One turn for each watch, each with the whole page in order.
    expect(turns(run).sort()).toEqual([
      "catch-up watch/chat 16",
      "catch-up watch/chat2 16",
      "catch-up watch/chat3 16",
    ]);
    for (const [input] of run.mock.calls) {
      const { trigger } = input as { trigger: Trigger };
      expect(
        trigger.type === "catch-up" &&
          trigger.events.map(({ event }) => event.content),
      ).toEqual(Array.from({ length: 16 }, (_, i) => `m${i}`));
    }
  } finally {
    vi.useRealTimers();
  }
});

it("does not catch up after a restart on a message it already heard live", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const first = await setup({ storage, identities: [echo] });
    vi.setSystemTime(start * 1000);
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    vi.setSystemTime((start + 1) * 1000);
    const live = posted("live", start + 1);
    first.emit({ events: [live] });
    await vi.waitFor(() => expect(first.run).toHaveBeenCalledTimes(1));
    // Closed before a tick moves the checkpoint past it.
    first.connect(false);
    vi.setSystemTime((start + 2) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      // Another message of the same second was not heard.
      history: [live, posted("unheard", start + 1)],
    });
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    await settle();
    await settle();
    expect(heard(second.run)).toEqual(["unheard"]);
  } finally {
    vi.useRealTimers();
  }
});

it("wakes a kind 9 watch added since for nothing older, though an overlapping watch catches up on it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    vi.setSystemTime(now * 1000);
    const watch = chat["watch/chat"];
    await service.save(bot, {
      attentionEnabled: true,
      attention: { "watch/channel": null, "watch/chat": watch },
    });
    await settle();
    history.push(posted("missed", now + 30));
    vi.setSystemTime((now + 60) * 1000);
    // Added after the message: a stream for its channel, one for all
    // channels, and a watch of every kind, which has none.
    await service.save(bot, {
      attention: {
        "watch/chat2": watch,
        "watch/all": { ...watch, channels: "all" as const },
        "watch/any": { ...watch, kinds: [] },
      },
    });
    await settle();
    vi.setSystemTime((now + 90) * 1000);
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await settle();
    await settle();
    // Only the watch of other kinds too, which hears what the app missed
    // since it listened, as a reconnect replay would give it.
    expect(turns(run).sort()).toEqual([
      "catch-up watch/any 1",
      "catch-up watch/chat 1",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("catches up no faster than its Interest's lane takes turns, so none is dropped", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const caught: number[] = [];
    const { service, history, recover, storage } = await setup({
      identities: [echo],
      runOnce: async ({ delivery }) => {
        const { trigger } = delivery;
        if (trigger.type === "catch-up") caught.push(trigger.events.length);
        if (caught.length === 1) await blocked;
        return { ok: true };
      },
    });
    const now = nowSeconds();
    vi.setSystemTime(now * 1000);
    await service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    vi.setSystemTime((now + 1_000) * 1000);
    // Ten turns of 64: one runs, and its lane keeps eight waiting.
    for (let i = 0; i < 640; i++) history.push(posted(`m${i}`, now + 1 + i));
    recover();
    // Nine turns are handed on, the last at the end of its 576th event.
    const progress = () =>
      Object.values(readCheckpoints(storage)).map(
        ({ through, after }) => after?.created_at ?? through,
      )[0] ?? 0;
    await vi.waitFor(() =>
      expect(progress()).toBeGreaterThanOrEqual(now + 576),
    );
    expect(caught).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(caught).toHaveLength(10), {
      timeout: 5_000,
    });
    expect(caught).toEqual(Array<number>(10).fill(64));
  } finally {
    vi.useRealTimers();
  }
});

it("gives a missed event to more of one Interest's watches than its lane holds, as room comes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const caught: string[] = [];
    const { service, history, recover } = await setup({
      identities: [echo],
      runOnce: async ({ delivery }) => {
        const { trigger } = delivery;
        if (trigger.type === "catch-up") caught.push(trigger.slug);
        if (caught.length === 1) await blocked;
        return { ok: true };
      },
    });
    const now = nowSeconds();
    vi.setSystemTime(now * 1000);
    // Ten watches in one Interest: one turn runs, and its lane keeps eight.
    const slugs = Array.from({ length: 10 }, (_, i) => `watch/chat${i}`);
    await service.save(bot, {
      attentionEnabled: true,
      attention: {
        "watch/channel": null,
        ...Object.fromEntries(slugs.map((slug) => [slug, chat["watch/chat"]])),
      },
    });
    await settle();
    vi.setSystemTime((now + 60) * 1000);
    history.push(posted("missed", now + 30));
    recover();
    await vi.waitFor(() => expect(caught).toHaveLength(1));
    await settle();
    release();
    await vi.waitFor(() => expect(caught).toHaveLength(10), {
      timeout: 5_000,
    });
    expect(caught.sort()).toEqual(slugs);
  } finally {
    vi.useRealTimers();
  }
}, 10_000);

it("keeps an Interest's room for a catch-up being classified, so live events cannot drop it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const jev = fakeJev();
    let answer!: (value: Answer) => void;
    jev.classify.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const { service, history, recover, emit } = await setup({
      jev,
      identities: [echo],
      runOnce: async ({ delivery }) => {
        const { trigger } = delivery;
        ran.push(
          trigger.type === "watch" ? (trigger.event.id[0] ?? "") : trigger.type,
        );
        if (ran.length === 1) await blocked;
        return { ok: true };
      },
    });
    const now = nowSeconds();
    vi.setSystemTime(now * 1000);
    await service.save(bot, {
      attentionEnabled: true,
      attention: {
        "watch/channel": null,
        "watch/chat": {
          ...chat["watch/chat"],
          classifier: {
            questions: {
              deploy: { question: "Is it about a deploy?", threshold: 0.5 },
            },
          },
        },
        // Live only, in the same Interest.
        "watch/likes": {
          type: "event",
          interest_id: "default",
          enabled: true,
          since: 1,
          channels: [channel],
          kinds: [7],
        },
      },
    });
    await settle();
    vi.setSystemTime((now + 60) * 1000);
    history.push(posted("missed", now + 30));
    recover();
    // The catch-up turn is being classified, and its checkpoint is past it.
    await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledOnce());
    await settle();
    // One runs; of the eight that then wait, the catch-up keeps one.
    const likes = Array.from({ length: 9 }, (_, i) =>
      event(`${i}`, { kind: 7, created_at: now + 61 + i }),
    );
    emit({ events: likes.slice(0, 1) });
    await vi.waitFor(() => expect(ran).toEqual(["0"]));
    emit({ events: likes.slice(1) });
    await settle();
    answer(yes);
    await settle();
    release();
    await vi.waitFor(() => expect(ran).toContain("catch-up"));
    await settle();
    expect(ran).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "catch-up"]);
  } finally {
    vi.useRealTimers();
  }
});

it("does not give a missed event again after a restart to watches that had it before the rest", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const caught: string[] = [];
    const first = await setup({
      storage,
      identities: [echo],
      runOnce: async ({ delivery }) => {
        const { trigger } = delivery;
        if (trigger.type === "catch-up") caught.push(trigger.slug);
        // The first finishes; the second holds its lane.
        if (caught.length > 1) await new Promise(() => {});
        return { ok: true };
      },
    });
    vi.setSystemTime(start * 1000);
    const slugs = Array.from({ length: 10 }, (_, i) => `watch/chat${i}`);
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: {
        "watch/channel": null,
        ...Object.fromEntries(slugs.map((slug) => [slug, chat["watch/chat"]])),
      },
    });
    await settle();
    vi.setSystemTime((start + 60) * 1000);
    const missed = posted("missed", start + 30);
    first.history.push(missed);
    first.recover();
    await vi.waitFor(() => expect(caught).toHaveLength(2));
    // Closed while the event has gone to only some of its watches.
    first.connect(false);
    vi.setSystemTime((start + 90) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      history: [missed],
    });
    await vi.waitFor(() => expect(second.run).toHaveBeenCalled());
    await settle();
    await settle();
    // The first eight had it, the one that finished included; the queued
    // ones are lost on quit, as any queued wake is.
    expect(caught[0]).toBe("watch/chat0");
    expect(turns(second.run).sort()).toEqual([
      "catch-up watch/chat8 1",
      "catch-up watch/chat9 1",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("waits for a confirmed roster before catching up, saving no progress past what it has not heard", async () => {
  vi.useFakeTimers({ now: 1_000_000_000 });
  try {
    const { service, run, history, recover, confirm, session, storage } =
      await setup({ identities: [echo] });
    const now = nowSeconds();
    // Every channel: "saved" has only a roster loaded from disk.
    const watch = { ...chat["watch/chat"], channels: "all" as const };
    await service.save(bot, {
      attentionEnabled: true,
      attention: { "watch/channel": null, "watch/chat": watch },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime((now + 400) * 1000);
    // More missed messages than the roster hold keeps.
    const missed = Array.from({ length: 300 }, (_, i) => `m${i}`);
    for (const [i, content] of missed.entries())
      history.push(eventDto(message(author, "saved", content, now + 1 + i)));
    recover();
    await vi.advanceTimersByTimeAsync(5_000);
    // The window is read once, whole, and then waits on the roster.
    const reads = catchUpReads(session).length;
    expect(reads).toBe(20);
    expect(run).not.toHaveBeenCalled();
    const saved = () =>
      Object.values(
        (
          JSON.parse(storage.getItem(CATCH_UP_KEY) ?? "{}") as {
            streams?: Record<string, { after?: unknown }>;
          }
        ).streams ?? {},
      );
    expect(saved().some((checkpoint) => checkpoint.after)).toBe(false);
    confirm("saved", [viewer, bot]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(heard(run)).toEqual(missed);
    // 64 to a turn.
    expect(run).toHaveBeenCalledTimes(5);
    expect(catchUpReads(session)).toHaveLength(reads);
  } finally {
    vi.useRealTimers();
  }
});

it("answers a mention catch-up reads from while it listened, not one from before", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const mention = (content: string, created_at: number) =>
      eventDto(message(author, channel, content, created_at, [["p", bot]]));
    const { service, run, history, recover } = await setup({
      identities: [echo],
      history: [mention("old", start - 10)],
    });
    await service.save(bot, { attentionEnabled: true, attention: chat });
    await settle();
    // Missed while the socket was down, live replay or not.
    vi.setSystemTime((start + 60) * 1000);
    history.push(mention("new", start + 30));
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(run)).toEqual(["new"]);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      trigger: { type: "mention" },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("wakes nothing from the time its attention was off", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, history, recover } = await setup({
      identities: [echo],
    });
    const start = nowSeconds();
    await service.save(bot, { attentionEnabled: true, attention: chat });
    await settle();
    await service.save(bot, { attentionEnabled: false });
    history.push(posted("while off", start));
    await service.save(bot, { attentionEnabled: true });
    // A reconnect a minute later catches up from when it was turned on.
    vi.setSystemTime((start + 60) * 1000);
    history.push(posted("after", start + 30));
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(run)).toEqual(["after"]);
  } finally {
    vi.useRealTimers();
  }
});

it("wakes nothing from the time its watch was off, also when it is turned on after a restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const first = await setup({ storage, identities: [echo] });
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    await first.service.save(bot, {
      attention: { "watch/chat": { ...chat["watch/chat"], enabled: false } },
    });
    first.history.push(posted("while off", start + 10));
    // Still off a while later, then the app quits.
    vi.setSystemTime((start + 20) * 1000);
    first.recover();
    await settle();
    first.connect(false);
    // Turned on again elsewhere while this copy was closed.
    const saved = storage.getItem("buzz.agents.v1") ?? "";
    storage.setItem(
      "buzz.agents.v1",
      saved.replace('"enabled":false', '"enabled":true'),
    );
    vi.setSystemTime((start + 60) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      history: [...first.history, posted("after", start + 30)],
    });
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(second.run)).toEqual(["after"]);
  } finally {
    vi.useRealTimers();
  }
});

it("wakes a watch only for channels the agent is in, even when it watches all", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/everything": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
      },
    },
  });
  emit({
    events: [
      // The owner's own channel, one whose roster is unknown, and no channel.
      event("secret", { tags: [["h", "private"]] }),
      event("unknown", { tags: [["h", "elsewhere"]] }),
      event("bare", { kind: 1, tags: [] }),
      event("open"),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    slug: "watch/everything",
    event: { id: "open".padEnd(64, "0") },
  });
});

it("answers an unmentioned one-to-one DM as conversation even when a watch matches it", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/everything": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
      },
    },
  });
  // The watch covers the DM too, but the DM rule answers first: one mention,
  // no standalone watch turn for the same message.
  emit({ events: [event("direct", { pubkey: viewer, tags: [["h", dm]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    type: "mention",
    event: { id: "direct".padEnd(64, "0") },
  });
  expect(run.mock.calls[0]?.[0].trigger).not.toHaveProperty("slug");
  // The same message in a stream channel is the watch's alone.
  emit({ events: [event("stream", { pubkey: viewer })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    type: "watch",
    slug: "watch/everything",
    event: { id: "stream".padEnd(64, "0") },
  });
});

it("keeps a new agent's attention off until its owner turns it on", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  expect(service.find(bot)?.attentionEnabled).toBe(false);
  // Its type's default watch matches, but wakes nothing while off.
  emit({ events: [deploy("one")] });
  await settle();
  await settle();
  expect(run).not.toHaveBeenCalled();
  await service.save(bot, { attentionEnabled: true });
  expect(service.find(bot)?.attentionEnabled).toBe(true);
  emit({ events: [deploy("two")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    type: "watch",
    event: { id: "two".padEnd(64, "0") },
  });
});

it("drops a queued watch run whose watch was disabled, or whose attention went off, before it ran", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  let release = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  emit({
    events: [deploy("one"), deploy("two")],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  await service.save(bot, {
    attention: { "watch/channel": { ...watch, enabled: false } as never },
  });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  // Back on: a run queued before attention went off does not run either.
  await service.save(bot, {
    attention: { "watch/channel": { ...watch, enabled: true } as never },
  });
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  emit({
    events: [deploy("three"), deploy("four")],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await service.save(bot, { attentionEnabled: false });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
});

it("drops a queued watch run when attention goes off and on, or its watch is replaced, before it ran", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  let release = () => {};
  const hold = () =>
    run.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
  hold();
  emit({
    events: [deploy("one"), deploy("two")],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await service.save(bot, { attentionEnabled: false });
  await service.save(bot, { attentionEnabled: true });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  // A replacement that still matches is a new watch: the old one's work goes.
  hold();
  emit({
    events: [deploy("three"), deploy("four")],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await service.save(bot, {
    attention: {
      "watch/channel": { ...watch, name: "Replaced" } as never,
    },
  });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
  // New events still wake the replacement.
  emit({ events: [deploy("five")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
});

it("tells a run whose type queued its work that it is current while another community is selected", async () => {
  const { service, run, emit, second, select } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  select(second.origin);
  expect(service.find(bot)).toBeUndefined();
  emit({ events: [deploy("one")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const delivery = run.mock.calls[0]?.[0] as Delivery;
  await settle();
  expect(delivery.current()).toBe(true);
  await service.save(bot, { attentionEnabled: false });
  expect(delivery.current()).toBe(false);
});

it("tells a run whose type queued its work whether that work is still current", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  emit({ events: [deploy("one")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const first = run.mock.calls[0]?.[0] as Delivery;
  // The run returned, as a type that queues its own work does.
  await settle();
  expect(first.current()).toBe(true);
  // An earlier turn tightened the watch: its event no longer matches.
  await service.save(bot, {
    attention: {
      "watch/channel": { ...watch, tags: { t: ["ship"] } } as never,
    },
  });
  expect(first.current()).toBe(false);
  await service.save(bot, {
    attention: { "watch/channel": watch as never },
  });
  emit({ events: [deploy("two")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const second = run.mock.calls[1]?.[0] as Delivery;
  await settle();
  expect(second.current()).toBe(true);
  await service.save(bot, { attentionEnabled: false });
  expect(second.current()).toBe(false);
});

it("voids a handed-off timer occurrence once attention or the timer is reset", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const timer = {
    type: "timer",
    interest_id: "default",
    prompt: "tick",
    enabled: true,
    interval_secs: 60,
    armed_at: 1_000,
    max_occurrences: null,
    expires_at: null,
  } as const;
  await service.save(bot, {
    attention: { "watch/channel": null, "watch/tick": timer },
  });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(1);
  // The run returned, as a type that hands the turn to its own queue does.
  const first = run.mock.calls[0]?.[0] as Delivery;
  expect(first.current()).toBe(true);
  // Turned off and on again while the turn waits for a process.
  await service.save(bot, { attentionEnabled: false });
  await service.save(bot, { attentionEnabled: true });
  expect(first.current()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  const second = run.mock.calls[1]?.[0] as Delivery;
  expect(second.current()).toBe(true);
  // Disabled and rearmed while it waits: the old occurrence stays void.
  await service.save(bot, {
    attention: { "watch/tick": { ...timer, enabled: false } },
  });
  await service.save(bot, {
    attention: { "watch/tick": { ...timer, armed_at: 1_100 } },
  });
  expect(second.current()).toBe(false);
});

it("runs a spent timer again when its owner restarts it", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const once = {
    type: "timer",
    interest_id: "default",
    prompt: "once",
    enabled: true,
    interval_secs: 60,
    armed_at: 1_000,
    max_occurrences: 1,
    expires_at: null,
  } as const;
  await service.save(bot, { attention: { "watch/once": once } });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(service.find(bot)?.timers["watch/once"]).toMatchObject({ used: 1 });
  // Rearming alone keeps the spent budget; a restart grants a fresh one.
  await service.save(bot, {
    attention: { "watch/once": { ...once, armed_at: 1_065 } },
  });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, {
    attention: { "watch/once": { ...once, armed_at: 1_130 } },
    restart: ["watch/once"],
  });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it("keeps an Interest while a watch still uses it", async () => {
  const { service } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await expect(
    service.save(bot, { attention: { "interest/default": null } }),
  ).rejects.toThrow(/use this Interest/);
  expect(service.find(bot)?.attention).toHaveProperty("interest/default");
  await service.save(bot, {
    attention: { "watch/channel": null, "interest/default": null },
  });
  expect(service.find(bot)?.attention).toEqual({});
});

const record = (pubkey: string, patch: Partial<RelayEvent> = {}) =>
  event(`r${pubkey.slice(0, 4)}`, {
    pubkey: viewer,
    kind: 30177,
    content: JSON.stringify({ name: "Far" }),
    tags: [
      ["d", pubkey],
      ["runtime", "example/echo"],
    ],
    ...patch,
  });
const hostedKey = "e".repeat(64);
function cloud() {
  const remote = {
    provision: vi.fn(async (_: { name: string; community: string }) => ({
      pubkey: hostedKey,
    })),
    activate: vi.fn(
      async (_: { pubkey: string; auth: readonly string[] }) => {},
    ),
    profile: vi.fn(async (_: { name: string; picture?: string }) => {}),
    remove: vi.fn(async (_: { pubkey: string }) => void steps.push("provider")),
  };
  const type: AgentType = {
    id: "cloud",
    title: "Cloud",
    defaults: () => ({ config: {} }),
    remote,
  };
  return { type, remote };
}

it("lists each agent here in the owner's agent records, with its type as the runtime", async () => {
  const { service, session } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenCalledWith(
      session,
      { pubkey: bot, name: "Echo", runtime: "example/echo" },
      expect.any(AbortSignal),
    ),
  );
  // Listed once: later syncs see the record it wrote.
  await service.save(bot, { config: { reply: "hi" } });
  await settle();
  expect(records.publish).toHaveBeenCalledTimes(1);
  // A rename replaces it.
  await service.save(bot, { name: "Echo Two" });
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenLastCalledWith(
      session,
      { pubkey: bot, name: "Echo Two", runtime: "example/echo" },
      expect.any(AbortSignal),
    ),
  );
});

it("leaves an agent already listed under its name and type as it is", async () => {
  const identity = {
    pubkey: bot,
    relay: "wss://relay.example.test",
    owner: viewer,
    type: "example/echo",
    name: "Echo",
    deleted: false,
  };
  const { service } = await setup({
    identities: [identity],
    listed: [record(bot, { content: JSON.stringify({ name: "Echo" }) })],
  });
  await vi.waitFor(() => expect(service.find(bot)?.place).toBe("here"));
  await settle();
  expect(records.publish).not.toHaveBeenCalled();
  expect(service.snapshot().agents).toHaveLength(1);
});

it("never relists an agent being deleted whose record is already gone", async () => {
  const { service } = await setup({
    identities: [{ ...here(bot), name: "Echo", deleting: true }],
    listed: [],
  });
  await vi.waitFor(() => expect(service.find(bot)?.deleting).toBe(true));
  await settle();
  expect(records.publish).not.toHaveBeenCalled();
});

it("shows the owner's agents on other devices without running them, and leaves earlier systems' records alone", async () => {
  const { service, emit, run, native } = await setup({
    listed: [
      record(sibling),
      record(other, { tags: [["d", other]], content: '{"name":"Old"}' }),
    ],
  });
  await vi.waitFor(() =>
    expect(service.find(sibling)).toMatchObject({
      name: "Far",
      type: "example/echo",
      place: "elsewhere",
      relay: "wss://relay.example.test",
      attention: {},
    }),
  );
  expect(service.find(other)).toBeUndefined();
  emit({
    events: [
      event("hey", {
        pubkey: viewer,
        tags: [
          ["h", channel],
          ["p", sibling],
        ],
      }),
    ],
  });
  await settle();
  expect(run).not.toHaveBeenCalled();
  expect(native.claim).not.toHaveBeenCalledWith(sibling);
  await expect(service.remove(sibling)).rejects.toThrow(/device that runs it/);
  await expect(service.save(sibling, { name: "Near" })).rejects.toThrow();
});

it("creates a hosted agent through its provider, attesting the key it returns", async () => {
  const { service, plugin, session, authorize, native, storage } =
    await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  const agent = await service.create({ type: "example/cloud", name: " Sky " });
  expect(remote.provision).toHaveBeenCalledWith({
    name: "Sky",
    community: "wss://relay.example.test",
    signal: expect.any(AbortSignal),
  });
  expect(authorize).toHaveBeenCalledWith(hostedKey, expect.any(AbortSignal));
  expect(remote.activate).toHaveBeenCalledWith({
    pubkey: hostedKey,
    name: "Sky",
    community: "wss://relay.example.test",
    auth: ["auth", viewer, "", "f".repeat(128)],
    signal: expect.any(AbortSignal),
  });
  expect(records.publish).toHaveBeenCalledWith(
    session,
    { pubkey: hostedKey, name: "Sky", runtime: "example/cloud" },
    expect.any(AbortSignal),
  );
  expect(agent).toMatchObject({ pubkey: hostedKey, place: "hosted" });
  expect(agent.unfinished).toBeUndefined();
  expect(native.create).not.toHaveBeenCalled();
  expect(native.claim).not.toHaveBeenCalledWith(hostedKey);
  expect(storage.getItem("buzz.agents.unfinished.v1")).toContain('"agents":[]');
});

it("keeps a hosted agent whose setup failed, and finishes it without making another", async () => {
  const storage = memoryStorage();
  const { service, plugin } = await setup({ storage });
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow("provider down");
  expect(service.find(hostedKey)).toMatchObject({
    place: "hosted",
    unfinished: true,
    name: "Sky",
  });
  expect(records.publish).not.toHaveBeenCalled();
  await expect(service.save(hostedKey, { name: "Sea" })).rejects.toThrow(
    /Finish the agent's setup/,
  );
  // A restart keeps it.
  const again = await setup({ storage });
  again.plugin.agents.register(cloud().type);
  await vi.waitFor(() =>
    expect(again.service.find(hostedKey)?.unfinished).toBe(true),
  );
  const agent = await service.finish(hostedKey);
  expect(remote.provision).toHaveBeenCalledTimes(1);
  expect(remote.activate).toHaveBeenCalledTimes(2);
  expect(agent.unfinished).toBeUndefined();
  expect(records.publish).toHaveBeenCalledTimes(1);
  expect(storage.getItem("buzz.agents.unfinished.v1")).not.toContain(hostedKey);
});

it("lists a hosted agent with the picture it was made with when its provider cannot publish it", async () => {
  const { service, plugin, session } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.profile.mockRejectedValueOnce(new Error("not supported"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const picture = "https://example.test/sky.png";
  const agent = await service.create({
    type: "example/cloud",
    name: "Sky",
    picture,
  });
  expect(records.publish).toHaveBeenCalledExactlyOnceWith(
    session,
    { pubkey: hostedKey, name: "Sky", picture, runtime: "example/cloud" },
    expect.any(AbortSignal),
  );
  expect(remote.profile).toHaveBeenCalledWith({
    pubkey: hostedKey,
    community: "wss://relay.example.test",
    name: "Sky",
    picture,
    signal: expect.any(AbortSignal),
  });
  expect(agent).toMatchObject({ pubkey: hostedKey, place: "hosted", picture });
  expect(service.find(hostedKey)?.picture).toBe(picture);
  expect(remote.provision).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    "Agent Sky picture was not published",
    expect.any(Error),
  );
  warn.mockRestore();
});

it("keeps a hosted agent's picture through a setup that failed, and lists it once finished", async () => {
  const storage = memoryStorage();
  const { service, plugin, session } = await setup({ storage });
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  const picture = "https://example.test/sky.png";
  await expect(
    service.create({ type: "example/cloud", name: "Sky", picture }),
  ).rejects.toThrow("provider down");
  expect(service.find(hostedKey)).toMatchObject({ unfinished: true, picture });
  expect(remote.profile).not.toHaveBeenCalled();
  // A restart keeps it.
  const again = await setup({ storage });
  again.plugin.agents.register(cloud().type);
  await vi.waitFor(() =>
    expect(again.service.find(hostedKey)).toMatchObject({
      unfinished: true,
      picture,
    }),
  );
  const agent = await service.finish(hostedKey);
  expect(agent).toMatchObject({ picture });
  expect(agent.unfinished).toBeUndefined();
  expect(records.publish).toHaveBeenCalledExactlyOnceWith(
    session,
    { pubkey: hostedKey, name: "Sky", picture, runtime: "example/cloud" },
    expect.any(AbortSignal),
  );
});

it("makes a hosted agent without a picture that is not an HTTPS image URL", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = await service.create({
    type: "example/cloud",
    name: "Sky",
    picture: "data:image/png;base64,AAAA",
  });
  expect(agent.picture).toBeUndefined();
  expect(remote.profile).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    "Agent Sky picture is not an HTTPS image URL",
  );
  warn.mockRestore();
});

it("renames a hosted agent through its provider and relists it; its settings are the provider's", async () => {
  const { service, plugin, session } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  await service.save(hostedKey, {
    name: "Sea",
    picture: "https://example.test/sea.png",
  });
  expect(remote.profile).toHaveBeenCalledWith({
    pubkey: hostedKey,
    community: "wss://relay.example.test",
    name: "Sea",
    picture: "https://example.test/sea.png",
    signal: expect.any(AbortSignal),
  });
  expect(records.publish).toHaveBeenLastCalledWith(
    session,
    {
      pubkey: hostedKey,
      name: "Sea",
      picture: "https://example.test/sea.png",
      runtime: "example/cloud",
    },
    expect.any(AbortSignal),
  );
  expect(service.find(hostedKey)).toMatchObject({
    name: "Sea",
    picture: "https://example.test/sea.png",
  });
  await expect(service.save(hostedKey, { config: {} })).rejects.toThrow(
    /through its provider/,
  );
});

it("deletes a hosted agent from its provider, then from its community", async () => {
  const { service, plugin, session } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  // A provider that fails leaves it listed, to delete again.
  remote.remove.mockRejectedValueOnce(new Error("provider down"));
  await expect(service.remove(hostedKey)).rejects.toThrow("provider down");
  expect(records.removeAgent).not.toHaveBeenCalled();
  expect(service.find(hostedKey)?.place).toBe("hosted");
  await service.remove(hostedKey);
  expect(records.removeAgent).toHaveBeenCalledWith(
    session,
    viewer,
    hostedKey,
    expect.any(AbortSignal),
  );
  expect(steps).toEqual(["provider", "leave"]);
  expect(remote.remove).toHaveBeenCalledWith({
    pubkey: hostedKey,
    community: "wss://relay.example.test",
    signal: expect.any(AbortSignal),
  });
  expect(service.find(hostedKey)).toBeUndefined();
});

it("deletes an unfinished hosted agent from its community too, as its profile may be out", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow();
  await service.remove(hostedKey);
  expect(steps).toEqual(["provider", "leave"]);
  expect(service.find(hostedKey)).toBeUndefined();
});

it("refuses to finish a hosted agent's setup while it is being deleted", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow();
  let release = () => {};
  remote.remove.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  const removing = service.remove(hostedKey);
  await expect(service.finish(hostedKey)).rejects.toThrow(/Wait for/);
  release();
  await removing;
  expect(remote.activate).toHaveBeenCalledTimes(1);
});

it("keeps an earlier system's settings when it lists an agent here under that record", async () => {
  const identity = {
    pubkey: bot,
    relay: "wss://relay.example.test",
    owner: viewer,
    type: "example/echo",
    name: "Echo",
    deleted: false,
  };
  const content = { name: "Old", parallelism: 2, respond_to: "anyone" };
  const tags = [
    ["d", bot],
    ["a", "30175:x:y"],
  ];
  const { service, session } = await setup({
    identities: [identity],
    listed: [record(bot, { tags, content: JSON.stringify(content) })],
  });
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenCalledWith(
      session,
      {
        pubkey: bot,
        name: "Echo",
        runtime: "example/echo",
        prior: { content, tags },
      },
      expect.any(AbortSignal),
    ),
  );
  expect(service.snapshot().agents).toHaveLength(1);
});

it("keeps what it lists while the community's records are read, and reads again after a failure", async () => {
  const { service, plugin, session, connect } = await setup();
  const { type } = cloud();
  plugin.agents.register(type);
  const read = vi.mocked(session.read);
  read.mockRejectedValueOnce(new Error("offline"));
  connect(false);
  connect(true);
  await settle();
  // The failed read lists nothing, and a sync reads again, held this time.
  let respond = (_: RelayEvent[]) => {};
  read.mockImplementationOnce(
    () =>
      new Promise<RelayEvent[]>((resolve) => {
        respond = resolve;
      }) as never,
  );
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  // Made meanwhile, it shows at once and stays once the read returns.
  await service.create({ type: "example/cloud", name: "Sky" });
  expect(service.find(hostedKey)).toMatchObject({ place: "hosted" });
  respond([]);
  await settle();
  expect(service.find(hostedKey)).toMatchObject({ place: "hosted" });
  // Then the agent here is listed too.
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ pubkey: bot }),
      expect.any(AbortSignal),
    ),
  );
});

it("lists only an HTTPS picture of a hosted agent", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  await expect(
    service.save(hostedKey, { picture: "data:image/png;base64,AAAA" }),
  ).rejects.toThrow(/HTTPS image URL/);
  expect(remote.profile).not.toHaveBeenCalled();
});

it("adds plugins' tools to every session, each name once", async () => {
  const { service, plugin, ctx } = await setup();
  const tool = {
    name: "tasks_create",
    description: "Create a task.",
    inputSchema: { type: "object" },
    call: async () => "created",
  };
  // Installed plugins add tools as bundled ones do.
  plugin.agents.addTool({ ...tool, name: "notes_add" });
  expect(service.tools()).toMatchObject([
    { name: "notes_add", pluginId: "example" },
  ]);
  const bundled = (id: string) =>
    ctx.extend({ pluginOwner: Object.freeze({ id, revision: "bundled" }) });
  const tasks = bundled("buzz.tasks");
  for (const bad of [
    { ...tool, name: "send" },
    { ...tool, name: "Tasks-Create" },
    { ...tool, description: "" },
    { ...tool, inputSchema: { type: "string" } },
    { ...tool, inputSchema: { type: "object", default: 1n } },
  ])
    expect(() => tasks.agents.addTool(bad)).toThrow(/Agent tools need/);
  expect(service.tools()).toHaveLength(1);
  tasks.agents.addTool(tool);
  expect(() =>
    bundled("buzz.other").agents.addTool({
      ...tool,
      call: async () => "other",
    }),
  ).toThrow(/Another plugin/);
  expect(service.tools()).toMatchObject([
    { name: "notes_add", pluginId: "example" },
    { name: "tasks_create", pluginId: "buzz.tasks" },
  ]);
});

it("reserves a tool name while its plugin is still starting", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => false,
    subscribe: () => () => {},
  });
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    fakeNative(),
    memoryStorage(),
  );
  const tool = {
    name: "tasks_create",
    description: "Create a task.",
    inputSchema: { type: "object" },
    call: async () => "created",
  };
  const owner = (id: string) =>
    ctx.extend({ pluginOwner: Object.freeze({ id, revision: "bundled" }) });
  const first = owner("buzz.tasks").plugin({
    inject: ["agents"],
    apply: (plugin: Context) => plugin.agents.addTool(tool),
  });
  await first;
  // Neither plugin is active yet, and still the name is taken.
  expect(service.tools()).toEqual([]);
  expect(() => owner("buzz.other").agents.addTool(tool)).toThrow(
    /Another plugin/,
  );
  await first.dispose();
  owner("buzz.other").agents.addTool(tool);
});

it("refuses a hosted type that also runs here", async () => {
  const { plugin } = await setup();
  const { type } = cloud();
  expect(() => plugin.agents.register({ ...type, run: () => {} })).toThrow(
    /hosted agent type/,
  );
});

it("brings over no identity as a hosted type, whose key stays with its provider", async () => {
  const { service, plugin, native } = await setup();
  plugin.agents.register(cloud().type);
  await expect(
    service.port({
      source: "installed",
      pubkey: sibling,
      type: "example/cloud",
    }),
  ).rejects.toThrow(/stays with its provider/);
  expect(native.port).not.toHaveBeenCalled();
});

it("refuses a key from the provider that the owner already lists", async () => {
  const { service, plugin } = await setup({ listed: [record(sibling)] });
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await vi.waitFor(() =>
    expect(service.find(sibling)?.place).toBe("elsewhere"),
  );
  remote.provision.mockResolvedValueOnce({ pubkey: sibling });
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow(/already in use/);
  expect(remote.activate).not.toHaveBeenCalled();
  expect(service.find(sibling)).toMatchObject({
    name: "Far",
    place: "elsewhere",
  });
});

it("lists a rename made while the agent's earlier record was being written", async () => {
  const { service, session } = await setup();
  let release = () => {};
  records.publish.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }) as never,
  );
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(records.publish).toHaveBeenCalledTimes(1));
  await service.save(bot, { name: "Echo Two" });
  await settle();
  expect(records.publish).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ pubkey: bot, name: "Echo Two" }),
      expect.any(AbortSignal),
    ),
  );
  await settle();
  expect(records.publish).toHaveBeenCalledTimes(2);
});

it("refuses to delete a hosted agent while its new name is being saved", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  let release = () => {};
  remote.profile.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  const saving = service.save(hostedKey, { name: "Sea" });
  await vi.waitFor(() => expect(remote.profile).toHaveBeenCalled());
  await expect(service.remove(hostedKey)).rejects.toThrow(/Wait for/);
  release();
  await saving;
  expect(remote.remove).not.toHaveBeenCalled();
  expect(service.find(hostedKey)).toMatchObject({ name: "Sea" });
});

it("keeps what it lists when the community's records cannot be read", async () => {
  const { service, plugin, session, connect } = await setup();
  plugin.agents.register(cloud().type);
  const read = vi.mocked(session.read);
  read.mockRejectedValueOnce(new Error("offline"));
  connect(false);
  connect(true);
  await settle();
  // Set up after the read failed, it is listed and shown.
  const agent = await service.create({ type: "example/cloud", name: "Sky" });
  expect(agent).toMatchObject({ pubkey: hostedKey, place: "hosted" });
  // Renamed while a read is under way that then fails, it keeps the new name.
  let fail = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise<RelayEvent[]>((_, reject) => {
        fail = () => reject(new Error("offline"));
      }) as never,
  );
  const reads = read.mock.calls.length;
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(read.mock.calls.length).toBe(reads + 1));
  await service.save(hostedKey, { name: "Sea" });
  fail();
  await settle();
  expect(service.find(hostedKey)).toMatchObject({
    name: "Sea",
    place: "hosted",
  });
  // The next read that succeeds keeps it too.
  await service.save(bot, { name: "Echo Two" });
  await vi.waitFor(() => expect(read.mock.calls.length).toBe(reads + 2));
  await settle();
  expect(service.find(hostedKey)).toMatchObject({
    name: "Sea",
    place: "hosted",
  });
});

it("projects accepted queued work and keeps working past handover until the plugin's actual result", async () => {
  const f = await setup();
  await f.service.create({ type: "example/echo", name: "Echo" });
  let releaseHandover!: () => void;
  let finish!: (outcome: WorkOutcome) => void;
  const done = new Promise<WorkOutcome>((resolve) => {
    finish = resolve;
  });
  f.run.mockImplementationOnce((delivery) => {
    delivery.workingUntil?.(done);
    return new Promise<void>((resolve) => {
      releaseHandover = resolve;
    });
  });
  const first = event("1", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  const second = event("2", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  f.emit({ events: [first, second], channelId: channel });
  try {
    await vi.waitFor(() =>
      expect(f.activity.reader.work().map((row) => row.state)).toEqual([
        "working",
        "waiting",
      ]),
    );
    expect(f.activity.reader.work()[0]).toMatchObject({
      agent: bot,
      messageId: first.id,
      threadRootId: first.id,
      channelId: channel,
    });
    releaseHandover();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(f.activity.reader.work().map((row) => row.state)).toEqual([
        "working",
        "done",
      ]),
    );
    finish({ ok: false, error: "Provider unavailable" });
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]).toMatchObject({
        state: "error",
        error: "Provider unavailable",
      }),
    );
  } finally {
    releaseHandover?.();
    finish({ ok: true });
    await f.ctx.fiber.dispose();
  }
});

it("shows a request whose run failed before handing anything over as failed, with why", async () => {
  const f = await setup();
  await f.service.create({ type: "example/echo", name: "Echo" });
  f.run.mockRejectedValueOnce(new Error("Couldn't read your Solo chats"));
  f.emit({
    events: [
      event("1", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  try {
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]).toMatchObject({
        state: "error",
        error: "Couldn't read your Solo chats",
      }),
    );
  } finally {
    await f.ctx.fiber.dispose();
  }
});

it("keeps a handed-off request and its original scope through reconnect, without reviving it from old callbacks", async () => {
  const f = await setup();
  await f.service.create({ type: "example/echo", name: "Echo" });
  let finish!: (result: WorkOutcome) => void;
  const done = new Promise<WorkOutcome>((resolve) => {
    finish = resolve;
  });
  f.run.mockImplementationOnce((delivery) => delivery.workingUntil?.(done));
  f.emit({
    events: [
      event("1", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  try {
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("working"),
    );
    const scope = f.activity.reader.work()[0]?.scope;
    f.reconnecting();
    f.connect(true);
    expect(f.activity.reader.work()[0]).toMatchObject({
      state: "working",
      scope,
    });
    finish({ ok: true });
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("done"),
    );
    expect(f.run).toHaveBeenCalledTimes(1);
  } finally {
    finish({ ok: true });
    await f.ctx.fiber.dispose();
  }
});

it("does not label still-running work failed when only its handover deadline expires", async () => {
  const f = await setup({ timeoutMs: 100 });
  await f.service.create({ type: "example/echo", name: "Echo" });
  let release!: () => void;
  let expired!: () => void;
  const deadline = new Promise<void>((resolve) => {
    expired = resolve;
  });
  f.run.mockImplementationOnce((delivery) => {
    delivery.signal.addEventListener("abort", expired, { once: true });
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  f.emit({
    events: [
      event("1", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("working"),
    );
    await deadline;
    await settle();
    expect(f.activity.reader.work()[0]?.state).toBe("working");
    release();
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("done"),
    );
  } finally {
    release?.();
    log.mockRestore();
    await f.ctx.fiber.dispose();
  }
});

it("clears declined requests and removed agents without late outcomes reviving activity", async () => {
  const f = await setup();
  await f.service.create({ type: "example/echo", name: "Echo" });
  const request = (id: string) => ({
    events: [
      event(id, {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
    channelId: channel,
  });
  let finish!: (result: WorkOutcome) => void;
  const done = new Promise<WorkOutcome>((resolve) => {
    finish = resolve;
  });
  try {
    f.native.claim.mockResolvedValue(false);
    f.emit(request("unclaimed"));
    await settle();
    expect(f.activity.reader.work()).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    f.native.claim.mockResolvedValue(true);
    f.run.mockImplementationOnce((delivery) => delivery.ignored?.());
    f.emit(request("declined"));
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    await settle();
    expect(f.activity.reader.work()).toEqual([]);
    f.run.mockImplementationOnce((delivery) => delivery.workingUntil(done));
    f.emit(request("active"));
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("working"),
    );
    await f.service.remove(bot);
    finish({ ok: false, error: "Late failure" });
    await settle();
    expect(f.activity.reader.work()).toEqual([]);
  } finally {
    finish({ ok: true });
    await f.ctx.fiber.dispose();
  }
});

/** The handle of the agent's next run, from a mention. */
async function handleOf(
  run: ReturnType<typeof vi.fn<(delivery: Delivery<Config>) => void>>,
  emit: (batch: LiveBatch) => void,
) {
  emit({
    events: [
      event("hi", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  return run.mock.calls.at(-1)?.[0].agent as Delivery["agent"];
}

it("lets a run read and write its attention with expected-state tokens", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const { attention } = await handleOf(run, emit);
  expect(attention.enabled()).toBe(true);
  expect(attention.classifier()).toBe("unavailable");
  expect(attention.interests()).toEqual(["default"]);
  const shown = await attention.show("interest/default");
  expect(shown).toMatchObject({
    result: "found",
    object: { id: "default", instructions: "Be brief." },
    expected_state: expect.stringMatching(/^object-v1:[0-9a-f]{64}$/),
  });
  const written = await attention.write(
    "interest/default",
    { type: "interest", instructions: "Be briefer." },
    { expected: shown.expected_state },
  );
  expect(written.object).toMatchObject({ instructions: "Be briefer." });
  // The owner sees the agent's write, and the old token no longer works.
  expect(service.find(bot)?.attention["interest/default"]?.value).toEqual({
    type: "interest",
    instructions: "Be briefer.",
  });
  await expect(
    attention.write(
      "interest/default",
      { type: "interest", instructions: "Stale." },
      { expected: shown.expected_state },
    ),
  ).rejects.toThrow(/^conflict:/);
});

it("keeps attention off across a reload", async () => {
  const { service, storage, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: false });
  const reloaded = await setup({
    storage,
    identities: await native.list(),
  });
  await vi.waitFor(() =>
    expect(reloaded.service.snapshot().status).toBe("ready"),
  );
  expect(reloaded.service.find(bot)?.attentionEnabled).toBe(false);
});

it("stops watches and timers while attention is off, keeps every object, and resumes them", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, {
    attentionEnabled: false,
    attention: {
      "watch/tick": {
        type: "timer",
        interest_id: "default",
        prompt: "check in",
        enabled: true,
        interval_secs: 60,
        armed_at: 1_000,
        max_occurrences: null,
        expires_at: null,
      },
    },
  });
  const before = service.find(bot);
  expect(before?.attentionEnabled).toBe(false);
  emit({ events: [deploy("w")] });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run).not.toHaveBeenCalled();
  // Mentions still reach it.
  emit({
    events: [
      event("m", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(run.mock.calls.map(([{ trigger }]) => trigger.type)).toEqual([
    "mention",
  ]);
  expect(run.mock.calls[0]?.[0].agent.attention.enabled()).toBe(false);
  await service.save(bot, { attentionEnabled: true });
  expect(service.find(bot)?.attention).toEqual(before?.attention);
  emit({ events: [deploy("w2")] });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run.mock.calls.map(([{ trigger }]) => trigger.type)).toEqual([
    "mention",
    "watch",
    "timer",
  ]);
});

/** What each presence call said, as `status:agents`. */
const said = (presence: { mock: { calls: unknown[][] } }) =>
  presence.mock.calls.map(
    ([status, agents]) => `${status}:${(agents as string[]).join(",")}`,
  );

it("says the agents it runs are online, again every minute and on a new session, and offline once removed", async () => {
  vi.useFakeTimers();
  const { service, presence, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(said(presence)).toEqual([`online:${bot}`]);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(said(presence)).toEqual([`online:${bot}`]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(said(presence)).toEqual([`online:${bot}`, `online:${bot}`]);
  connect(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(said(presence)).toHaveLength(3);
  await service.remove(bot);
  await vi.advanceTimersByTimeAsync(0);
  expect(said(presence).at(-1)).toBe(`offline:${bot}`);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(said(presence)).toHaveLength(4);
});

it("leaves an agent another copy of the app holds to that copy, and does not say it went offline", async () => {
  vi.useFakeTimers();
  const { service, presence, native } = await setup();
  native.claim.mockResolvedValue(false);
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(said(presence)).toEqual([]);
  native.claim.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(said(presence)).toEqual([`online:${bot}`]);
  native.claim.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(said(presence)).toEqual([`online:${bot}`]);
});

it("tries a refused presence again after half a minute, not every tick", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { service, presence } = await setup();
  presence.mockRejectedValueOnce(new Error("rate-limited"));
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(presence).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(presence).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(presence).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    "Agent presence was not sent",
    expect.any(Error),
  );
  warn.mockRestore();
});

it("stops trying presence on a session that cannot send it", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { service, presence, connect } = await setup();
  presence.mockResolvedValue(false);
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(presence).toHaveBeenCalledTimes(1);
  // Count only presence warnings: an earlier test's service still runs.
  const warned = () =>
    warn.mock.calls.filter(([text]) =>
      String(text).startsWith("Agent presence cannot be sent"),
    ).length;
  expect(warned()).toBe(1);
  presence.mockResolvedValue(true);
  connect(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(presence).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});

it("gives a run its owner's channel templates with the owner's agents each adds", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.create({ type: "example/echo", name: "Sib" });
  const team = await service.saveTeam({
    name: "Crew",
    instructions: "",
    members: [sibling],
  });
  vi.spyOn(channelTemplates, "snapshot").mockReturnValueOnce([
    {
      id: "t",
      name: "Launch",
      teams: [team.id],
      agents: [other, bot],
      canvas: "# Plan",
    },
  ]);
  const { templates } = await handleOf(run, emit);
  expect(templates()).toEqual([
    { name: "Launch", canvas: "# Plan", agents: [bot, sibling] },
  ]);
});

describe("Delete as a recoverable archive", () => {
  type Life = "active" | "archiving" | "archived" | "recovering";
  /** One community's config whose archive state lands in the service's own
   * lifecycle journal, as the real one's does. */
  function fakeConfig() {
    const life = { next: "archived" as Life };
    let journals: ConfigJournals | undefined;
    let community = "";
    const put = (state: Life) =>
      journals?.lifecycle.put(
        community,
        bot,
        state === "active" ? undefined : { state, channel: "cfg" },
      );
    const config = {
      life,
      archive: vi.fn(async () => {
        put(life.next);
        return life.next;
      }),
      recover: vi.fn(async () => {
        put("active");
        return "active";
      }),
      save: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
      resume: vi.fn(async () => {}),
      attach: vi.fn(async () => []),
      migrateTeams: vi.fn(async () => {}),
      binding: () => undefined,
      teams: () => undefined,
      settled: () => true,
      dispose() {},
    };
    const open = (input: CommunityConfigInput) => {
      journals = input.journals;
      community = input.community;
      return config;
    };
    return Object.assign(open, config);
  }
  afterEach(() => {
    communityFake.value = null;
  });
  const mention = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
    f.emit({
      events: [
        event(id, {
          tags: [
            ["h", channel],
            ["p", bot],
          ],
        }),
      ],
      channelId: channel,
    });

  it("archives instead of deleting, keeps the key, and blocks starts until recovered", async () => {
    const config = fakeConfig();
    communityFake.value = config;
    const f = await setup();
    await f.service.create({ type: "example/echo", name: "Echo" });
    await vi.waitFor(() => expect(config.resume).toHaveBeenCalled());
    await f.service.remove(bot);
    expect(config.archive).toHaveBeenCalledWith(bot);
    expect(f.native.remove).not.toHaveBeenCalled();
    expect(f.service.snapshot().agents.map((a) => a.pubkey)).not.toContain(bot);
    mention(f, "1");
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]).toMatchObject({
        state: "error",
        error: "This agent is deleted; recover it from Settings",
      }),
    );
    expect(f.run).not.toHaveBeenCalled();
    await f.service.recover(bot);
    expect(config.recover).toHaveBeenCalledWith(bot);
    mention(f, "2");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    await f.ctx.fiber.dispose();
  });

  it("keeps starts blocked while an archive is unconfirmed, and says so", async () => {
    const config = fakeConfig();
    config.life.next = "archiving";
    communityFake.value = config;
    const f = await setup();
    await f.service.create({ type: "example/echo", name: "Echo" });
    await vi.waitFor(() => expect(config.resume).toHaveBeenCalled());
    await f.service.remove(bot);
    expect(f.service.find(bot)?.lifecycle).toBe("archiving");
    mention(f, "1");
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]).toMatchObject({ state: "error" }),
    );
    expect(f.run).not.toHaveBeenCalled();
    await f.ctx.fiber.dispose();
  });

  it("never deletes, edits or starts locally an agent synced before, while its community is unavailable", async () => {
    // A restart onto a relay that is down or no longer supports config
    // channels: only the persisted journal says the agent synced.
    const storage = memoryStorage();
    new MigrationJournal(storage).put(
      {
        owner: viewer,
        community: "https://relay.example.test",
        subject: alder,
        type: "buzz.agent.instructions",
        channel: "",
      },
      { status: "confirmed", channelId: "cfg", d: "x", attempts: 1 },
    );
    const f = await setup({ storage, identities: [here(alder)] });
    await expect(f.service.remove(alder)).rejects.toThrow(
      "Alder's config syncs through its community, which isn't connected.",
    );
    expect(f.native.beginDelete).not.toHaveBeenCalled();
    expect(f.native.remove).not.toHaveBeenCalled();
    await expect(
      f.service.save(alder, { config: { reply: "local edit" } }),
    ).rejects.toThrow("isn't connected");
    mention(f, "1");
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]).toMatchObject({ state: "error" }),
    );
    expect(f.run).not.toHaveBeenCalled();
    await f.ctx.fiber.dispose();
  });

  it("saves through the community with the editor's base, and never reports an unconfirmed save as saved", async () => {
    const config = fakeConfig();
    config.save.mockResolvedValue({
      instructions: {
        status: "uncertain",
        message: "may have been saved",
        retired: false,
      },
    });
    communityFake.value = config;
    const f = await setup();
    await f.service.create({ type: "example/echo", name: "Echo" });
    await vi.waitFor(() => expect(config.resume).toHaveBeenCalled());
    const base = { instructions: null };
    await expect(
      f.service.save(bot, { config: { reply: "edit" }, base }),
    ).rejects.toThrow();
    expect(config.save).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: bot }),
      { reply: "edit" },
      base,
    );
    await f.ctx.fiber.dispose();
  });

  /** The real per-agent config wiring over an in-memory config relay that
   * outlives each service, so restarts and reconnects meet the same heads. */
  function configRelay(
    teams: () => Promise<
      { id: string; archived: boolean; label: string; members?: string[] }[]
    > = async () => [],
  ) {
    const owner = keypair();
    const heads = new Map<string, RelayEvent>();
    /** Config channels by subject label, as the relay keeps them. */
    const channels = new Map<
      string,
      { id: string; family: string; archived: boolean; members: string[] }
    >();
    const archiveChannel = (id: string, archived: boolean) => {
      for (const channel of channels.values())
        if (channel.id === id) channel.archived = archived;
    };
    /** While set, no config channel can be made. */
    const offline = { value: false };
    /** While set, the relay takes each revision only once it settles. */
    const held: { value?: Promise<void> | undefined } = {};
    const publishing = vi.fn();
    /** While set, no team channel can be made. */
    const noTeams = { value: false };
    const failTeamReads = { value: false };
    const addMember = vi.fn(async (id: string, pubkey: string) => {
      const found = [...channels.values()].find((c) => c.id === id);
      if (found && !found.members.includes(pubkey)) found.members.push(pubkey);
      return { status: "confirmed" as const };
    });
    const key = (event: RelayEvent) =>
      event.tags.find(([name]) => name === "d")?.[1] ?? "";
    const opens = vi.fn((input: CommunityConfigInput) =>
      agentConfigs({
        channels: {
          ensure: vi.fn(async (family: string, subject: string) => {
            if (offline.value || (family === "team-config" && noTeams.value))
              throw new Error("Offline");
            if (family === "agent-config")
              return {
                id: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
                archived: false,
              };
            const made = channels.get(subject) ?? {
              id: crypto.randomUUID(),
              family,
              archived: false,
              members: [input.owner],
            };
            channels.set(subject, made);
            return made;
          }),
          find: vi.fn(async (family: string, subject: string) =>
            family === "agent-config"
              ? { id: "9b353519-f4fe-4757-aef4-bec6cc0ae54c", archived: false }
              : channels.get(subject),
          ),
          teams: vi.fn(async () => [
            ...(await teams()),
            ...[...channels].map(([label, channel]) => ({ ...channel, label })),
          ]),
          addMember,
          removeMember: vi.fn(async (id: string, pubkey: string) => {
            const found = [...channels.values()].find((c) => c.id === id);
            if (found)
              found.members = found.members.filter((p) => p !== pubkey);
            return { status: "confirmed" as const };
          }),
          owns: vi.fn(async () => true),
          archive: vi.fn(async (id: string) => archiveChannel(id, true)),
          unarchive: vi.fn(async (id: string) => archiveChannel(id, false)),
          archived: vi.fn(
            async (id: string) =>
              [...channels.values()].find((c) => c.id === id)?.archived ??
              false,
          ),
        },
        teamJournal: input.journals.teams,
        ops: input.journals.ops,
        lifecycle: input.journals.lifecycle,
        sync: {
          // A team channel's first read installs its head, as sync's does.
          bind: vi.fn(
            async (
              bindings: readonly {
                family: string;
                subject: string;
                channel: string;
              }[],
            ) => {
              for (const { family, subject, channel } of bindings) {
                if (family !== "team-config") continue;
                const head = [...heads.values()].find((event) =>
                  event.tags.some(
                    ([name, value]) => name === "h" && value === channel,
                  ),
                );
                const artifact = {
                  owner: input.owner,
                  community: input.community,
                  subject,
                  channel,
                  type: "buzz.team" as const,
                };
                if (head)
                  input.store.applyRead(
                    artifact,
                    input.store.capture(artifact),
                    { kind: "head", event: head },
                  );
              }
            },
          ),
          unbind: vi.fn(),
          dispose() {},
        },
        deps: {
          read: async (filters) => {
            if (
              failTeamReads.value &&
              filters.some((filter) =>
                [...channels.values()].some((c) =>
                  (filter["#h"] ?? []).includes(c.id),
                ),
              )
            )
              throw new Error("team head unreadable");
            return [...heads.values()].filter((event) =>
              filters.some(
                (filter) =>
                  (filter["#d"] ?? []).includes(key(event)) ||
                  (filter.ids ?? []).includes(event.id),
              ),
            );
          },
          writer: {
            sign: async (template) => signed(owner, template),
            async publish(event) {
              publishing(event);
              await held.value;
              const head = heads.get(key(event));
              const prev = event.tags.find(([name]) => name === "prev")?.[1];
              if (!head || prev === head.id) heads.set(key(event), event);
            },
          },
          store: input.store,
          journal: input.journals.migration,
          maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
          signal: new AbortController().signal,
        },
        owner: input.owner,
        community: input.community,
        communityId: COMMUNITY_UUID,
        strip: input.strip,
        changed: input.changed,
        retire: input.retire,
      }),
    );
    /** Team `id`, made on another device: its config channel and head. */
    const remoteTeam = async (id: string, members: string[]) => {
      const channelId = crypto.randomUUID();
      channels.set(await teamSubject(id), {
        id: channelId,
        family: "team-config",
        archived: false,
        members: [viewer, ...members],
      });
      const head = await signed(owner, {
        kind: 45010,
        created_at: 1,
        content: JSON.stringify({
          version: 1,
          name: "Remote",
          instructions: "TEAM RULE",
        }),
        tags: [
          ["ar", "1"],
          ["d", await artifactD("buzz.team", channelId)],
          ["h", channelId],
          ["type", "buzz.team"],
          ["title", "Remote"],
          ["op", "create"],
          ["team", id],
        ],
      });
      heads.set(key(head), head);
      return channelId;
    };
    return {
      opens,
      heads,
      addMember,
      channels,
      offline,
      noTeams,
      failTeamReads,
      held,
      remoteTeam,
      publishing,
      owner,
    };
  }
  const mentionAlder = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
    f.emit({
      events: [
        event(id, {
          tags: [
            ["h", channel],
            ["p", alder],
          ],
        }),
      ],
      channelId: channel,
    });

  it("with config sync on, keeps a synced agent's authority across reconnect, downgrade and restart", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const f = await setup({ storage, identities: [here(alder)] });
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    expect(relay.heads.size).toBe(1);
    // A new session opens a new community config; the agent stays synced.
    f.reconnecting();
    f.connect(true);
    await vi.waitFor(() => expect(relay.opens).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    mentionAlder(f, "1");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    // The relay stops supporting config channels on the next session.
    communityFake.value = null;
    f.reconnecting();
    f.connect(true);
    await settle();
    await expect(f.service.remove(alder)).rejects.toThrow("isn't connected");
    await expect(
      f.service.save(alder, { config: { reply: "local edit" } }),
    ).rejects.toThrow("isn't connected");
    expect(f.native.beginDelete).not.toHaveBeenCalled();
    expect(f.native.remove).not.toHaveBeenCalled();
    // Starts still come from the confirmed synced copy.
    mentionAlder(f, "2");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    await f.ctx.fiber.dispose();
    // A restart while the relay still can't sync keeps every refusal.
    const again = await setup({ storage, identities: [here(alder)] });
    await expect(again.service.remove(alder)).rejects.toThrow(
      "isn't connected",
    );
    expect(again.native.remove).not.toHaveBeenCalled();
    await again.ctx.fiber.dispose();
  });

  it("with config sync on, blocks a member's start while its team can't be read, and shows the team safely", async () => {
    const storage = memoryStorage();
    // Only an unfinished change of this device's names the channel's team.
    new TeamOps(storage).write({
      edit: {
        id: "edit",
        owner: viewer,
        community: "https://relay.example.test",
        teamId: "5d2f6c1e-0d7b-4c51-9a63-2a9a1a0c7e11",
        channel: "0c9e7a52-3b1d-4f6e-8a20-6d4b2f9e1c33",
        kind: "edit",
        intent: { name: "Core", instructions: "", members: [alder] },
        commands: [],
        mode: "reconcile-only",
        seq: 1,
      },
    });
    const relay = configRelay(async () => [
      {
        id: "0c9e7a52-3b1d-4f6e-8a20-6d4b2f9e1c33",
        archived: false,
        label: "unproven",
        members: [viewer, alder],
      },
    ]);
    communityFake.value = relay.opens;
    const f = await setup({ storage, identities: [here(alder)] });
    await vi.waitFor(() =>
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({
          id: "5d2f6c1e-0d7b-4c51-9a63-2a9a1a0c7e11",
          members: [alder],
          note: UNREADABLE_TEAM,
        }),
      ]),
    );
    mentionAlder(f, "1");
    await settle();
    expect(f.run).not.toHaveBeenCalled();
    await f.ctx.fiber.dispose();
  });

  it("with config sync on, imports an old Buzz team onto the one team every device and restart reaches", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const expected = await importedTeamId({
      owner: viewer,
      community: COMMUNITY_UUID,
      source: "old-buzz-team",
      sourceId: "old-night-shift",
    });
    const imports = async (storage: Storage) => {
      const f = await setup({ storage, identities: [here(alder)] });
      listsTeam(f.native, nightShift([alder]));
      await vi.waitFor(() => expect(relay.opens).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const result = await importTeam(f.service);
      await f.ctx.fiber.dispose();
      return result;
    };
    const laptop = memoryStorage();
    const first = await imports(laptop);
    expect(first.team).toMatchObject({
      id: expected,
      name: "Night Shift",
      members: [alder],
    });
    // No local copy: the team is its config channel's.
    expect(readTeams(laptop)).toEqual([]);
    // Another device, then this one after a restart, meet the same team.
    expect((await imports(memoryStorage())).team?.id).toBe(expected);
    expect((await imports(laptop)).team?.id).toBe(expected);
    expect(relay.channels.size).toBe(1);
    // Once that team is deleted, an import offers its archived copy back.
    const [only] = [...relay.channels.values()];
    if (only) only.archived = true;
    const late = await imports(memoryStorage());
    expect(late.team).toBeUndefined();
    expect(late.archived).toEqual({ id: expected });
    expect(relay.channels.size).toBe(1);
  });

  it("with config sync on, moves an earlier import's local copy onto the old Buzz team's id", async () => {
    const relay = configRelay();
    communityFake.value = null;
    const storage = memoryStorage();
    writeTeams(storage, [savedShift([alder])]);
    const f = await setup({ storage, identities: [here(alder)] });
    listsTeam(f.native, nightShift([alder]));
    // The relay starts supporting config channels on the next session.
    communityFake.value = relay.opens;
    f.reconnecting();
    f.connect(true);
    const expected = await importedTeamId({
      owner: viewer,
      community: COMMUNITY_UUID,
      source: "old-buzz-team",
      sourceId: "old-night-shift",
    });
    await vi.waitFor(() =>
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({ id: expected, members: [alder] }),
      ]),
    );
    expect(readTeams(storage)).toEqual([]);
    await f.ctx.fiber.dispose();
  });

  it("with config sync on, resumes a team's pending members and a stopped Create from its saved records alone", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const [joined, created] = [crypto.randomUUID(), crypto.randomUUID()];
    relay.channels.set(await teamSubject(joined), {
      id: "c0a8012e-7d3b-4a5f-9c61-2e4b8d9f0a17",
      family: "team-config",
      archived: false,
      members: [viewer, alder],
    });
    const storage = memoryStorage();
    const record = (id: string, seq: number): TeamOp => ({
      id,
      owner: viewer,
      community: "https://relay.example.test",
      teamId: id,
      kind: "create",
      intent: { name: "Core", instructions: "", members: [alder, birch] },
      base: null,
      commands: [],
      mode: "may-send",
      seq,
    });
    new TeamOps(storage).write({
      // Its channel was made and one member added; the other never was.
      [joined]: {
        ...record(joined, 1),
        channel: "c0a8012e-7d3b-4a5f-9c61-2e4b8d9f0a17",
        commands: [{ action: "add", pubkey: alder, state: "confirmed" }],
      },
      // Create stopped before the team's channel was made.
      [created]: record(created, 2),
    });
    const f = await setup({
      storage,
      identities: [here(alder), here(birch)],
    });
    await vi.waitFor(() =>
      expect(relay.addMember).toHaveBeenCalledWith(
        "c0a8012e-7d3b-4a5f-9c61-2e4b8d9f0a17",
        birch,
        expect.anything(),
      ),
    );
    await vi.waitFor(() =>
      expect(f.service.snapshot().teams).toContainEqual(
        expect.objectContaining({ id: created, name: "Core" }),
      ),
    );
    expect(relay.channels.size).toBe(2);
    await f.ctx.fiber.dispose();
  });

  it("with config sync on, makes one team however often a stopped Create is clicked", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    const create = () =>
      f.service.saveTeam({
        creation: "6f1c2b9e-4a3d-4c1e-9b2a-1d2e3f4a5b6c",
        name: "Core",
        instructions: "",
        members: [alder],
      });
    relay.offline.value = true;
    await expect(create()).rejects.toThrow();
    relay.offline.value = false;
    const team = await create();
    expect(team.id).toBe("6f1c2b9e-4a3d-4c1e-9b2a-1d2e3f4a5b6c");
    expect(new TeamOps(f.storage).every()).toEqual([]);
    expect(relay.channels.size).toBe(1);
    await f.ctx.fiber.dispose();
  });

  it("keeps team sections while a synced community is unavailable", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      await f.service.saveTeam({
        name: "Core",
        instructions: "TEAM RULE",
        members: [alder],
      });
      mentionAlder(f, "before");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      expect(f.run.mock.calls[0]?.[0].team).toContain("TEAM RULE");
      communityFake.value = null;
      f.reconnecting();
      f.connect(true);
      await settle();
      mentionAlder(f, "after");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
      expect(f.run.mock.calls[1]?.[0].team).toContain("TEAM RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("blocks an unreadable team even with a cached present head", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const team = await f.service.saveTeam({
        name: "Core",
        instructions: "TEAM RULE",
        members: [alder],
      });
      mentionAlder(f, "before");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      expect(f.run.mock.calls[0]?.[0].team).toContain("TEAM RULE");
      const config = relay.opens.mock.results[0]?.value;
      const synced = config
        ?.teams()
        ?.find((t: { id: string }) => t.id === team.id);
      if (!config || !synced) throw new Error("no synced team");
      for (const [d, head] of relay.heads)
        if (
          head.tags.some(
            ([name, value]) => name === "h" && value === synced.channel,
          )
        )
          relay.heads.delete(d);
      config.rosterChanged(synced.channel);
      await vi.waitFor(() =>
        expect(
          f.service.snapshot().teams.find((t) => t.id === team.id)?.note,
        ).toBe(UNREADABLE_TEAM),
      );
      mentionAlder(f, "after");
      await settle();
      expect(f.run).toHaveBeenCalledTimes(1);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("the discovered card refuses dropping a joined member of its unfinished Create", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder), here(birch)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const add = relay.addMember.getMockImplementation();
      if (!add) throw new Error("Missing member fake");
      relay.addMember.mockImplementation(async (id, pubkey) =>
        pubkey === birch
          ? ({ status: "refused", error: "Try later" } as never)
          : add(id, pubkey),
      );
      const creation = crypto.randomUUID();
      await expect(
        f.service.saveTeam({
          creation,
          name: "Partial",
          instructions: "RULE",
          members: [alder, birch],
        }),
      ).rejects.toThrow();
      expect(new TeamOps(f.storage).every()).toEqual([
        expect.objectContaining({ kind: "create" }),
      ]);
      expect(f.service.snapshot().teams).toContainEqual(
        expect.objectContaining({ id: creation }),
      );
      // The retry could now succeed; dropping A must still be refused before any edit starts.
      relay.addMember.mockImplementation(add);
      // TeamEditor opened from that card sends id and a fresh form id, not operation.
      await expect(
        f.service.saveTeam({
          id: creation,
          creation: crypto.randomUUID(),
          name: "Partial",
          instructions: "RULE",
          members: [birch],
        }),
      ).rejects.toThrow("remove them after the team is created");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  /** A Create of alder and birch whose birch add is refused: alder joins,
   * the Create stays unfinished. Returns the member fake to restore. */
  const partialCreate = async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder), here(birch)] });
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    const add = relay.addMember.getMockImplementation();
    if (!add) throw new Error("Missing member fake");
    relay.addMember.mockImplementation(async (id, pubkey) =>
      pubkey === birch
        ? ({ status: "refused", error: "Try later" } as never)
        : add(id, pubkey),
    );
    const creation = crypto.randomUUID();
    const team = {
      creation,
      name: "Partial",
      instructions: "RULE",
      members: [alder, birch],
    };
    await expect(f.service.saveTeam(team)).rejects.toThrow();
    const [op] = new TeamOps(f.storage).every();
    if (op?.kind !== "create") throw new Error("Missing unfinished Create");
    return { f, relay, add, team, op };
  };

  it("an unfinished Create drops an unfinished Create drop a never-joined member", async () => {
    const { f, relay, team, op } = await partialCreate();
    try {
      expect(
        [...relay.channels.values()].find((c) => c.family === "team-config")
          ?.members,
      ).not.toContain(birch);
      await expect(
        f.service.saveTeam({ ...team, operation: op.id, members: [alder] }),
      ).resolves.toMatchObject({ id: team.creation, members: [alder] });
      expect(new TeamOps(f.storage).every()).toEqual([]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("a card Save during an unfinished Create revises it, so B isn't added back", async () => {
    const { f, relay, team, add } = await partialCreate();
    try {
      const roster = () =>
        [...relay.channels.values()].find((c) => c.family === "team-config")
          ?.members ?? [];
      expect(roster()).not.toContain(birch);
      await expect(
        f.service.saveTeam({
          ...team,
          id: team.creation,
          creation: crypto.randomUUID(),
          members: [alder],
        }),
      ).resolves.toMatchObject({ members: [alder] });
      // The Save revised the Create to {A}, which finished it; nothing is
      // left to add B back once B can join.
      relay.addMember.mockImplementation(add);
      for (const left of new TeamOps(f.storage).every())
        await f.service.teamChange(left.id, "check");
      expect(new TeamOps(f.storage).every()).toEqual([]);
      expect(roster()).not.toContain(birch);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("an unfinished Create refuses dropping a joined member when its roster can't be read", async () => {
    let failed = false;
    const relay = configRelay(async () => {
      if (failed) throw new Error("Roster unavailable");
      return [];
    });
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder), here(birch)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const config = relay.opens.mock.results[0]?.value;
      if (!config) throw new Error("Missing config");
      await config.refreshTeams();
      expect(config.teams()).toEqual([]);
      const add = relay.addMember.getMockImplementation();
      if (!add) throw new Error("Missing add");
      relay.addMember.mockImplementation(async (id, pubkey) =>
        pubkey === birch
          ? ({ status: "refused", error: "Try later" } as never)
          : add(id, pubkey),
      );
      failed = true;
      const team = {
        creation: crypto.randomUUID(),
        name: "Partial",
        instructions: "RULE",
        members: [alder, birch],
      };
      await expect(f.service.saveTeam(team)).rejects.toThrow();
      const op = new TeamOps(f.storage).every()[0];
      if (!op) throw new Error("Missing Create");
      expect(
        [...relay.channels.values()].find((c) => c.family === "team-config")
          ?.members,
      ).toContain(alder);
      await f.service.teamChange(op.id, "check");
      expect(
        new TeamOps(f.storage)
          .every()[0]
          ?.commands.some((c) => c.pubkey === alder),
      ).toBe(false);
      // The last discovery was the empty list before A joined; refresh still fails.
      expect(config.teams()).toEqual([]);
      relay.addMember.mockImplementation(add);
      await expect(
        f.service.saveTeam({ ...team, operation: op.id, members: [birch] }),
      ).rejects.toThrow("joined or may have joined");
      // A created channel that can't be found now proves no roster.
      relay.channels.clear();
      await expect(
        f.service.saveTeam({ ...team, operation: op.id, members: [birch] }),
      ).rejects.toThrow("can't be read");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("an unfinished Create's refusal survives restart and Dismiss releases it", async () => {
    const { f, relay, team, op } = await partialCreate();
    const storage = f.storage;
    await f.ctx.fiber.dispose();
    const again = await setup({
      storage,
      identities: [here(alder), here(birch)],
    });
    try {
      await vi.waitFor(() =>
        expect(again.service.find(alder)?.configBase).toBeDefined(),
      );
      await relay.opens.mock.results.at(-1)?.value.resumeTeams();
      const card = {
        id: team.creation,
        creation: crypto.randomUUID(),
        name: "Partial",
        instructions: "RULE",
        members: [birch],
      };
      await expect(again.service.saveTeam(card)).rejects.toThrow(
        "remove them after the team is created",
      );
      await again.service.teamChange(op.id, "discard");
      const stopped = again.service
        .snapshot()
        .teamChanges?.find((c) => c.id === op.id);
      expect(stopped).toMatchObject({ stopped: true, unresolved: false });
      await expect(again.service.saveTeam(card)).rejects.toThrow(
        "remove them after the team is created",
      );
      await again.service.teamChange(op.id, "dismiss");
      relay.addMember.mockImplementation(async (id, pubkey) => {
        const channel = [...relay.channels.values()].find((c) => c.id === id);
        if (channel && !channel.members.includes(pubkey))
          channel.members.push(pubkey);
        return { status: "confirmed" as const };
      });
      await expect(again.service.saveTeam(card)).resolves.toMatchObject({
        members: [birch],
      });
    } finally {
      await again.ctx.fiber.dispose();
    }
  });

  it("an unfinished Create refuses dropping a maybe-sent member", async () => {
    const { f, relay, team, op } = await partialCreate();
    try {
      relay.addMember.mockResolvedValue({ status: "uncertain" } as never);
      await f.service.teamChange(op.id, "check");
      expect(new TeamOps(f.storage).every()[0]?.commands).toContainEqual(
        expect.objectContaining({ pubkey: birch, state: "maybe-sent" }),
      );
      await expect(
        f.service.saveTeam({ ...team, operation: op.id, members: [alder] }),
      ).rejects.toThrow("joined or may have joined");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("an unfinished Create still refuses dropping its joined member after Check again", async () => {
    const { f, team, op } = await partialCreate();
    try {
      // birch is still refused, so Check again leaves the Create unfinished.
      await f.service.teamChange(op.id, "check").catch(() => {});
      expect(new TeamOps(f.storage).every()).toEqual([
        expect.objectContaining({ id: op.id }),
      ]);
      await expect(
        f.service.saveTeam({ ...team, operation: op.id, members: [birch] }),
      ).rejects.toThrow("remove them after the team is created");
      expect(new TeamOps(f.storage).every()[0]?.intent.members).toEqual([
        alder,
        birch,
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("once its Create finishes, the card's edit drops a member", async () => {
    const { f, relay, add, team } = await partialCreate();
    try {
      relay.addMember.mockImplementation(add);
      await f.service.saveTeam(team);
      expect(new TeamOps(f.storage).every()).toEqual([]);
      await expect(
        f.service.saveTeam({
          id: team.creation,
          creation: crypto.randomUUID(),
          name: "Partial",
          instructions: "RULE",
          members: [birch],
        }),
      ).resolves.toMatchObject({ members: [birch] });
      expect(
        [...relay.channels.values()].find((c) => c.family === "team-config")
          ?.members,
      ).not.toContain(alder);
      expect(new TeamOps(f.storage).every()).toEqual([]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("retry of a partial Create keeps its team id", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const add = relay.addMember.getMockImplementation();
      if (!add) throw new Error("The relay fake adds members");
      // The add lands, but its reply is lost: only a roster read settles it.
      relay.addMember.mockImplementation(async (id, pubkey) => {
        const result = await add(id, pubkey);
        return [...relay.channels.values()].some((c) => c.id === id)
          ? ({ status: "uncertain" } as never)
          : result;
      });
      const form = {
        creation: "6f1c2b9e-4a3d-4c1e-9b2a-1d2e3f4a5b6c",
        name: "Partial",
        instructions: "RULE",
        members: [alder],
      };
      await expect(f.service.saveTeam(form)).rejects.toThrow();
      const [started] = new TeamOps(f.storage).every();
      expect(pending(started)).toEqual([alder]);
      relay.addMember.mockImplementation(add);
      const completed = await f.service.saveTeam(form);
      expect(completed.id).toBe(started?.teamId);
      expect(relay.channels.size).toBe(1);
      expect(new TeamOps(f.storage).every()).toEqual([]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it.each(["name", "instructions"] as const)(
    "a partial Create retry after changing %s does not duplicate",
    async (field) => {
      const relay = configRelay();
      communityFake.value = relay.opens;
      const f = await setup({ identities: [here(alder)] });
      try {
        await vi.waitFor(() =>
          expect(f.service.find(alder)?.configBase).toBeDefined(),
        );
        const add = relay.addMember.getMockImplementation();
        if (!add) throw new Error("The relay fake adds members");
        // The add lands, but its reply is lost: only a roster read settles it.
        relay.addMember.mockImplementation(async (id, pubkey) => {
          const result = await add(id, pubkey);
          return [...relay.channels.values()].some((c) => c.id === id)
            ? ({ status: "uncertain" } as never)
            : result;
        });
        const form = {
          creation: "6f1c2b9e-4a3d-4c1e-9b2a-1d2e3f4a5b6c",
          name: "Partial",
          instructions: "RULE",
          members: [alder],
        };
        await expect(f.service.saveTeam(form)).rejects.toThrow();
        const [started] = new TeamOps(f.storage).every();
        relay.addMember.mockImplementation(add);
        const completed = await f.service.saveTeam({
          ...form,
          [field]: "Changed",
        });
        expect.soft(completed.id).toBe(started?.teamId);
        expect.soft(relay.channels.size).toBe(1);
        expect.soft(new TeamOps(f.storage).every()).toEqual([]);
      } finally {
        await f.ctx.fiber.dispose();
      }
    },
  );

  it("Create rejects a member operation that throws before it can be journaled pending", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const add = relay.addMember.getMockImplementation();
      if (!add) throw new Error("The relay fake adds members");
      relay.addMember.mockImplementation(async (id, pubkey) => {
        if ([...relay.channels.values()].some((c) => c.id === id))
          throw new Error("Disconnected during ownership read");
        return add(id, pubkey);
      });
      await expect(
        f.service.saveTeam({
          name: "Throwing",
          instructions: "RULE",
          members: [alder],
        }),
      ).rejects.toThrow();
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("a team discovered on another device refuses offline Delete and edit without a migration entry", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const laptop = await setup({ identities: [here(alder)] });
    let team: Awaited<ReturnType<typeof laptop.service.saveTeam>>;
    try {
      await vi.waitFor(() =>
        expect(laptop.service.find(alder)?.configBase).toBeDefined(),
      );
      team = await laptop.service.saveTeam({
        name: "Remote",
        instructions: "RULE",
        members: [alder],
      });
    } finally {
      await laptop.ctx.fiber.dispose();
    }
    const other = await setup({
      identities: [here(alder)],
      storage: memoryStorage(),
    });
    try {
      await vi.waitFor(() =>
        expect(other.service.snapshot().teams).toContainEqual(
          expect.objectContaining({ id: team.id }),
        ),
      );
      expect(new TeamOps(other.storage).every()).toHaveLength(0);
      expect(
        new TeamJournal(other.storage).known(
          viewer,
          "https://relay.example.test",
        ),
      ).toContainEqual(expect.objectContaining({ id: team.id }));
      communityFake.value = null;
      other.reconnecting();
      other.connect(true);
      await settle();
      await expect
        .soft(other.service.removeTeam(team.id))
        .rejects.toThrow("isn't available");
      await expect
        .soft(other.service.saveTeam({ ...team, name: "Changed" }))
        .rejects.toThrow();
    } finally {
      await other.ctx.fiber.dispose();
    }
  });

  it("an unfinished move refuses editing or deleting its local team while its community is away, and resumes it intact", async () => {
    const relay = configRelay();
    relay.noTeams.value = true;
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const local = {
      id: "local-before-sync",
      name: "Local",
      instructions: "RULE",
      members: [alder],
    };
    writeTeams(storage, [local]);
    const f = await setup({ identities: [here(alder)], storage });
    try {
      await vi.waitFor(() =>
        expect(new TeamOps(storage).every()).toHaveLength(1),
      );
      const [migration] = new TeamOps(storage).every();
      expect(migration?.teamId).not.toBe(local.id);
      communityFake.value = null;
      f.reconnecting();
      f.connect(true);
      await settle();
      await expect(
        f.service.saveTeam({ ...local, name: "Changed" }),
      ).rejects.toThrow("reconnect to its community");
      await expect(f.service.removeTeam(local.id)).rejects.toThrow(
        "reconnect to its community",
      );
      expect(readTeams(storage)).toEqual([local]);
      relay.noTeams.value = false;
      communityFake.value = relay.opens;
      f.reconnecting();
      f.connect(true);
      await vi.waitFor(() => expect(relay.opens).toHaveBeenCalledTimes(2));
      const config = relay.opens.mock.results[1]?.value;
      if (!config) throw new Error("Missing reconnected config");
      await config.attach([
        {
          pubkey: alder,
          name: "Alder",
          type: "example/echo",
          config: { reply: "ok" },
        },
      ]);
      await config.resumeTeams();
      await settle();
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({ name: "Local", instructions: "RULE" }),
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("offline Delete alone is refused and reconnect preserves the original team", async () => {
    const relay = configRelay();
    relay.noTeams.value = true;
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const local = {
      id: "local-before-sync",
      name: "Local",
      instructions: "RULE",
      members: [alder],
    };
    writeTeams(storage, [local]);
    const f = await setup({ identities: [here(alder)], storage });
    try {
      await vi.waitFor(() =>
        expect(new TeamOps(storage).every()).toHaveLength(1),
      );
      const [migration] = new TeamOps(storage).every();
      expect(migration?.teamId).not.toBe(local.id);
      communityFake.value = null;
      f.reconnecting();
      f.connect(true);
      await settle();
      await expect(f.service.removeTeam(local.id)).rejects.toThrow(
        "reconnect to its community",
      );
      expect(readTeams(storage)).toEqual([local]);
      relay.noTeams.value = false;
      communityFake.value = relay.opens;
      f.reconnecting();
      f.connect(true);
      await vi.waitFor(() => expect(relay.opens).toHaveBeenCalledTimes(2));
      const config = relay.opens.mock.results[1]?.value;
      if (!config) throw new Error("Missing reconnected config");
      await config.attach([
        {
          pubkey: alder,
          name: "Alder",
          type: "example/echo",
          config: { reply: "ok" },
        },
      ]);
      await config.resumeTeams();
      await settle();
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({ name: "Local", instructions: "RULE" }),
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("Save again after background completion retains the partial Create id", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const add = relay.addMember.getMockImplementation();
      if (!add) throw new Error("The relay fake adds members");
      // The add lands, but its reply is lost: only a roster read settles it.
      relay.addMember.mockImplementation(async (id, pubkey) => {
        const result = await add(id, pubkey);
        return [...relay.channels.values()].some((c) => c.id === id)
          ? ({ status: "uncertain" } as never)
          : result;
      });
      const form = {
        creation: "6f1c2b9e-4a3d-4c1e-9b2a-1d2e3f4a5b6c",
        name: "Partial",
        instructions: "RULE",
        members: [alder],
      };
      await expect(f.service.saveTeam(form)).rejects.toThrow();
      const [started] = new TeamOps(f.storage).every();
      relay.addMember.mockImplementation(add);
      await relay.opens.mock.results[0]?.value.resumeTeams();
      expect(new TeamOps(f.storage).every()).toEqual([]);
      const completed = await f.service.saveTeam(form);
      expect.soft(completed.id).toBe(started?.teamId);
      expect.soft(relay.channels.size).toBe(1);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("user Import reports unconfirmed team membership", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const add = relay.addMember.getMockImplementation();
      if (!add) throw new Error("The relay fake adds members");
      // The add lands, but its reply is lost: only a roster read settles it.
      relay.addMember.mockImplementation(async (id, pubkey) => {
        const result = await add(id, pubkey);
        return [...relay.channels.values()].some((c) => c.id === id)
          ? ({ status: "uncertain" } as never)
          : result;
      });
      listsTeam(f.native, nightShift([alder]));
      const imported = await importTeam(f.service);
      expect.soft(imported.team).toBeUndefined();
      expect
        .soft(
          imported.teamError ||
            imported.notes?.length ||
            imported.failed.length,
        )
        .toBeTruthy();
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("an archived import with a maybe-sent member add reports what needs checking, keeping its change", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      // The add's reply is lost, and the roster never shows it.
      relay.addMember.mockResolvedValue({ status: "uncertain" } as never);
      listsTeam(f.native, nightShift([alder]));
      await importTeam(f.service);
      // Deleted elsewhere before the add is confirmed.
      const [only] = [...relay.channels.values()];
      if (only) only.archived = true;
      const again = await importTeam(f.service);
      expect(again.archived).toBeUndefined();
      expect(again.teamError).toEqual({ name: "Night Shift" });
      expect(f.service.snapshot().teamChanges).toEqual([
        expect.objectContaining({ kind: "import", unresolved: true }),
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("Create does not report unconfirmed team membership as success", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      relay.addMember.mockImplementation(async (id) =>
        [...relay.channels.values()].some((c) => c.id === id)
          ? ({ status: "uncertain" } as never)
          : { status: "confirmed" },
      );
      await expect(
        f.service.saveTeam({
          name: "Pending",
          instructions: "RULE",
          members: [alder],
        }),
      ).rejects.toThrow();
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("Delete does not report an unavailable synced team as success", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const team = await f.service.saveTeam({
        name: "Offline",
        instructions: "RULE",
        members: [alder],
      });
      communityFake.value = null;
      f.reconnecting();
      f.connect(true);
      await settle();
      await expect(f.service.removeTeam(team.id)).rejects.toThrow();
      expect([...relay.channels.values()][0]?.archived).toBe(false);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("Create does not report failed team membership as success", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      relay.addMember.mockImplementation(async (id) =>
        [...relay.channels.values()].some((c) => c.id === id)
          ? ({ status: "failed", error: "denied" } as never)
          : { status: "confirmed" },
      );
      await expect(
        f.service.saveTeam({
          name: "Denied",
          instructions: "RULE",
          members: [alder],
        }),
      ).rejects.toThrow();
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("rejects an uncertain team artifact save", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const team = await f.service.saveTeam({
        name: "Core",
        instructions: "",
        members: [alder],
      });
      const config = relay.opens.mock.results[0]?.value;
      if (!config) throw new Error("no config");
      vi.spyOn(config, "editTeam").mockRejectedValue(
        new Error("Some steps may have been saved; Check again confirms them."),
      );
      await expect(
        f.service.saveTeam({ ...team, instructions: "edit" }),
      ).rejects.toThrow();
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it.each([
    ["another community", viewer, "https://not-joined.example.test"],
    ["another owner", "e".repeat(64), "https://relay.example.test"],
  ])(
    "with config sync on, keeps local team rules when a same-id relay team is known for %s",
    async (_, owner, community) => {
      const relay = configRelay();
      communityFake.value = relay.opens;
      const id = "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
      const storage = memoryStorage();
      writeTeams(storage, [
        {
          id,
          name: "Local",
          instructions: "SCOPED LOCAL RULE",
          members: [alder],
        },
      ]);
      storage.setItem(
        TEAMS_MIGRATION_KEY,
        JSON.stringify({
          version: 1,
          known: {
            [`${community}\n${owner}`]: [
              {
                id,
                channel: crypto.randomUUID(),
                archived: false,
                unreadable: false,
                members: [],
              },
            ],
          },
        }),
      );
      const f = await setup({ identities: [here(alder)], storage });
      try {
        await vi.waitFor(() =>
          expect(f.service.find(alder)?.configBase).toBeDefined(),
        );
        await relay.opens.mock.results[0]?.value.refreshTeams();
        mentionAlder(f, "foreign-discovery");
        await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
        expect(f.run.mock.calls[0]?.[0].team).toContain("SCOPED LOCAL RULE");
      } finally {
        await f.ctx.fiber.dispose();
      }
    },
  );

  it("with config sync on, keeps local team rules after empty relay discovery", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      await f.service.saveTeam({
        name: "Local",
        instructions: "LOCAL RULE MUST REMAIN",
        members: [alder],
      });
      await relay.opens.mock.results[0]?.value.refreshTeams();
      mentionAlder(f, "local-after-discovery");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      expect(f.run.mock.calls[0]?.[0].team).toContain("LOCAL RULE MUST REMAIN");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  /** Re-reads teams in every community the fake opened. */
  const refreshAll = (relay: ReturnType<typeof configRelay>) =>
    Promise.all(
      relay.opens.mock.results.map((result) => result.value?.refreshTeams()),
    );
  const count = (text: string | undefined, part: string) =>
    (text ?? "").split(part).length - 1;
  /** A local team whose members span two communities: it never moves. */
  const spanning = (id: string) => ({
    id,
    name: "Spanning",
    instructions: "SPANNING LOCAL RULE",
    members: [alder, birch],
  });
  const spanSetup = async (id: string) => {
    const storage = memoryStorage();
    writeTeams(storage, [spanning(id)]);
    const f = await setup({
      storage,
      identities: [here(alder), here(birch, "wss://other.example.test")],
    });
    // Ready at once locally, but one CI rerun passed the default 1 s for an
    // unknown reason: extra time tolerates a slow run, not a known cause.
    await vi.waitFor(
      () => expect(f.service.find(alder)?.configBase).toBeDefined(),
      { timeout: 5_000 },
    );
    return f;
  };

  it("with config sync on, runs a team spanning communities with its local rules beside a distinct relay team", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await spanSetup("local-spanning");
    try {
      await relay.remoteTeam("7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", [alder]);
      await refreshAll(relay);
      mentionAlder(f, "both");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      const team = f.run.mock.calls[0]?.[0].team;
      expect(count(team, "SPANNING LOCAL RULE")).toBe(1);
      expect(count(team, "TEAM RULE")).toBe(1);
      expect(readTeams(f.storage)).toEqual([spanning("local-spanning")]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("with config sync on, uses the relay team over a local team with the same id in its scope", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const id = "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
    const f = await spanSetup(id);
    try {
      await relay.remoteTeam(id, [alder]);
      await refreshAll(relay);
      mentionAlder(f, "same-id");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      const team = f.run.mock.calls[0]?.[0].team;
      expect(count(team, "TEAM RULE")).toBe(1);
      expect(team).not.toContain("SPANNING LOCAL RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  /** A local team whose move onto the relay is held: its relay team exists
   * with other text, made elsewhere, and the move hasn't adopted it yet. */
  async function heldMove(options: { models?: () => Promise<void> } = {}) {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const local = {
      id: "local-moving",
      name: "Moving",
      instructions: "LOCAL MOVING RULE",
      members: [alder],
    };
    writeTeams(storage, [local]);
    const target = await importedTeamId({
      owner: viewer,
      community: COMMUNITY_UUID,
      source: "local-team",
      sourceId: local.id,
    });
    // Teams can't be made yet: the move waits with no channel.
    relay.noTeams.value = true;
    const f = await setup({ storage, identities: [here(alder)], ...options });
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    await vi.waitFor(() =>
      expect(new TeamOps(storage).every()).toHaveLength(1),
    );
    const config = relay.opens.mock.results[0]?.value;
    if (!config) throw new Error("No community config");
    // The same team appears on the relay, roster and all, with other text.
    await relay.remoteTeam(target, [alder]);
    await config.refreshTeams();
    /** The move adopts the relay team, establishing it; a member command
     * left unconfirmed keeps the move unfinished. */
    const establish = async () => {
      relay.addMember.mockResolvedValue({ status: "uncertain" } as never);
      const [channel] = [...relay.channels.values()];
      if (channel) channel.members = [viewer];
      await config.resumeTeams();
      if (channel) channel.members = [viewer, alder];
      await config.refreshTeams();
      const [op] = new TeamOps(storage).every();
      expect(op?.confirmedHead).toBeDefined();
      expect(readTeams(storage)).toEqual([local]);
    };
    return { f, relay, storage, config, establish };
  }
  /** Stops the move's change, settles it and runs `action` on it. */
  const stopThen = async (
    f: Awaited<ReturnType<typeof setup>>,
    action: "dismiss" | "resubmit",
  ) => {
    const change = f.service.snapshot().teamChanges?.[0];
    if (!change) throw new Error("no unfinished move");
    await f.service.teamChange(change.id, "discard");
    await f.service.teamChange(change.id, "check");
    expect(f.service.snapshot().teamChanges?.[0]?.unresolved).toBe(false);
    await f.service.teamChange(change.id, action).catch(() => {});
  };
  const promptOf = async (f: Awaited<ReturnType<typeof setup>>, id: string) => {
    mentionAlder(f, id);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    return f.run.mock.calls[0]?.[0].team ?? "";
  };

  /** A local team whose move can't make its channel yet: the move stays
   * unfinished and unpublished. */
  const stuckMove = async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const local = {
      id: "local-stuck",
      name: "Stuck",
      instructions: "STUCK RULE",
      members: [alder],
    };
    writeTeams(storage, [local]);
    relay.noTeams.value = true;
    const f = await setup({ storage, identities: [here(alder)] });
    await vi.waitFor(() =>
      expect(f.service.snapshot().teamChanges).toHaveLength(1),
    );
    const config = relay.opens.mock.results[0]?.value;
    if (!config) throw new Error("No community config");
    const resume = async () => {
      relay.noTeams.value = false;
      await config.resumeTeams();
      expect(new TeamOps(storage).every()).toEqual([]);
    };
    return { f, storage, local, resume };
  };

  it("refuses editing a local team whose move is unfinished, so resuming it loses nothing", async () => {
    const { f, storage, local, resume } = await stuckMove();
    try {
      await expect(
        f.service.saveTeam({ ...local, instructions: "NEWER RULE" }),
      ).rejects.toThrow("Unfinished changes");
      expect(readTeams(storage)).toEqual([local]);
      await resume();
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({ instructions: "STUCK RULE" }),
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("refuses deleting a local team whose move is unfinished, so resuming it recreates nothing deleted", async () => {
    const { f, storage, local, resume } = await stuckMove();
    try {
      await expect(f.service.removeTeam(local.id)).rejects.toThrow(
        "Unfinished changes",
      );
      expect(readTeams(storage)).toEqual([local]);
      await resume();
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({ name: "Stuck" }),
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("refuses Dismiss for an unestablished move even when an old team list lacks its relay team", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const local = {
      id: "local-stale-discovery",
      name: "Moving",
      instructions: "LOCAL MOVING RULE",
      members: [alder],
    };
    writeTeams(storage, [local]);
    relay.noTeams.value = true;
    const target = await importedTeamId({
      owner: viewer,
      community: COMMUNITY_UUID,
      source: "local-team",
      sourceId: local.id,
    });
    const f = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      await vi.waitFor(() =>
        expect(new TeamOps(storage).every()).toHaveLength(1),
      );
      const config = relay.opens.mock.results[0]?.value;
      if (!config) throw new Error("no config");
      await config.refreshTeams();
      expect(config.teams()).toEqual([]);
      await relay.remoteTeam(target, [alder]); // no discovery event has arrived yet
      const [op] = new TeamOps(storage).every();
      await f.service.teamChange(op?.id ?? "", "discard");
      await f.service.teamChange(op?.id ?? "", "dismiss").catch(() => {});
      await config.refreshTeams();
      const prompt = await promptOf(f, "stale-discovery-dismiss");
      expect(
        count(prompt, "LOCAL MOVING RULE") + count(prompt, "TEAM RULE"),
      ).toBe(1);
      expect(new TeamOps(storage).every()).toHaveLength(1);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it.each(["other-only", "spanning", "unavailable"])(
    "keeps a reopened operation in its own community with %s edited members",
    async (scenario) => {
      const first = configRelay(),
        second = configRelay();
      first.noTeams.value = true;
      communityFake.value = (input: CommunityConfigInput) =>
        (input.community === "https://relay.example.test"
          ? first
          : second
        ).opens(input);
      const storage = memoryStorage(),
        operation = crypto.randomUUID(),
        teamId = crypto.randomUUID();
      new TeamOps(storage).write({
        [operation]: {
          id: operation,
          teamId,
          owner: viewer,
          community: "https://relay.example.test",
          kind: "create",
          base: null,
          intent: {
            name: "Pending",
            instructions: "SAVED RULE",
            members: [alder],
          },
          commands: [],
          mode: "may-send",
          seq: 1,
        },
      });
      const f = await setup({
        storage,
        identities: [here(alder), here(birch, "wss://other.example.test")],
      });
      try {
        await vi.waitFor(() =>
          expect(f.service.find(alder)?.configBase).toBeDefined(),
        );
        await vi.waitFor(() =>
          expect(
            f.service.snapshot().running.find((a) => a.pubkey === birch)
              ?.configBase,
          ).toBeDefined(),
        );
        await first.opens.mock.results[0]?.value.resumeTeams();
        if (scenario === "unavailable") {
          f.leave("https://relay.example.test");
          await settle();
          await expect(
            f.service.saveTeam({
              creation: teamId,
              operation,
              name: "Revised",
              instructions: "NEW RULE",
              members: [birch],
            }),
          ).rejects.toThrow("community isn't available");
          expect(new TeamOps(storage).every()[0]?.intent.instructions).toBe(
            "SAVED RULE",
          );
        } else {
          first.noTeams.value = false;
          await f.service.saveTeam({
            creation: teamId,
            operation,
            name: "Revised",
            instructions: "NEW RULE",
            members: scenario === "spanning" ? [alder, birch] : [birch],
          });
          expect(new TeamOps(storage).every()).toEqual([]);
          expect(
            [...first.heads.values()].map((h) => h.content).join(),
          ).toContain("NEW RULE");
        }
        expect(second.channels.size).toBe(0);
        expect(readTeams(storage)).toEqual([]);
      } finally {
        await f.ctx.fiber.dispose();
      }
    },
  );

  it("saves a reopened Create whose change finished here as an edit of its team", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    relay.noTeams.value = true;
    const storage = memoryStorage(),
      operation = crypto.randomUUID(),
      teamId = crypto.randomUUID();
    new TeamOps(storage).write({
      [operation]: {
        id: operation,
        teamId,
        owner: viewer,
        community: "https://relay.example.test",
        kind: "create",
        base: null,
        intent: {
          name: "Pending",
          instructions: "SAVED RULE",
          members: [alder],
        },
        commands: [],
        mode: "may-send",
        seq: 1,
      },
    });
    const f = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const config = relay.opens.mock.results[0]?.value;
      await config?.resumeTeams();
      relay.noTeams.value = false;
      await config?.resumeTeams();
      expect(new TeamOps(storage).every()).toEqual([]);
      // Its own change finished here: Save edits that team, on its head.
      const channelsBefore = relay.channels.size;
      await expect(
        f.service.saveTeam({
          creation: teamId,
          operation,
          name: "Revised",
          instructions: "NEW RULE",
          members: [alder],
        }),
      ).resolves.toMatchObject({ id: teamId, instructions: "NEW RULE" });
      expect(new TeamOps(storage).every()).toEqual([]);
      expect(relay.channels.size).toBe(channelsBefore);
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({ id: teamId, instructions: "NEW RULE" }),
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("saves a reopened Create again after its own edit finished under Check again", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const storage = memoryStorage(),
      operation = crypto.randomUUID(),
      teamId = crypto.randomUUID();
    new TeamOps(storage).write({
      [operation]: {
        id: operation,
        teamId,
        owner: viewer,
        community: "https://relay.example.test",
        kind: "create",
        base: null,
        intent: {
          name: "Pending",
          instructions: "SAVED RULE",
          members: [alder],
        },
        commands: [],
        mode: "may-send",
        seq: 1,
      },
    });
    const f = await setup({ storage, identities: [here(alder), here(birch)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      await relay.opens.mock.results[0]?.value.resumeTeams();
      expect(new TeamOps(storage).every()).toEqual([]);
      const add = relay.addMember.getMockImplementation();
      if (!add) throw new Error("Missing member fake");
      relay.addMember.mockImplementation(async (id, pubkey) =>
        pubkey === birch
          ? ({ status: "refused", error: "Try later" } as never)
          : add(id, pubkey),
      );
      const form = {
        creation: teamId,
        operation,
        name: "Pending",
        members: [alder, birch],
      };
      // The editor's first Save edits the team, but birch's add waits.
      await expect(
        f.service.saveTeam({ ...form, instructions: "EDIT RULE" }),
      ).rejects.toThrow();
      const [edit] = new TeamOps(storage).every();
      if (edit?.kind !== "edit") throw new Error("Missing unfinished edit");
      relay.addMember.mockImplementation(add);
      await f.service.teamChange(edit.id, "check");
      expect(new TeamOps(storage).every()).toEqual([]);
      // Its next Save builds on that edit's head, not the Create's.
      await expect(
        f.service.saveTeam({ ...form, instructions: "LATEST RULE" }),
      ).resolves.toMatchObject({ id: teamId, instructions: "LATEST RULE" });
      expect(new TeamOps(storage).every()).toEqual([]);
      expect(f.service.snapshot().teams).toEqual([
        expect.objectContaining({ id: teamId, instructions: "LATEST RULE" }),
      ]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("completion before restart refuses a stale operation safely and keeps its submitted draft", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const operation = crypto.randomUUID(),
      teamId = crypto.randomUUID();
    new TeamOps(storage).write({
      [operation]: {
        id: operation,
        teamId,
        owner: viewer,
        community: "https://relay.example.test",
        kind: "create",
        base: null,
        intent: {
          name: "Pending",
          instructions: "SAVED RULE",
          members: [alder],
        },
        commands: [],
        mode: "may-send",
        seq: 1,
      },
    });
    const first = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(first.service.find(alder)?.configBase).toBeDefined(),
      );
      await relay.opens.mock.results[0]?.value.resumeTeams();
      expect(new TeamOps(storage).every()).toEqual([]);
    } finally {
      await first.ctx.fiber.dispose();
    }
    const heads = [...relay.heads.values()],
      channelsBefore = relay.channels.size;
    const again = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(again.service.find(alder)?.configBase).toBeDefined(),
      );
      await expect(
        again.service.saveTeam({
          creation: teamId,
          operation,
          name: "Revised",
          instructions: "NEW RULE",
          members: [alder],
        }),
      ).rejects.toThrow("changed on another device");
      expect([...relay.heads.values()]).toEqual(heads);
      expect(relay.channels.size).toBe(channelsBefore);
      expect(new TeamOps(storage).every()).toEqual([
        expect.objectContaining({
          teamId,
          stop: "conflict",
          intent: expect.objectContaining({ instructions: "NEW RULE" }),
        }),
      ]);
    } finally {
      await again.ctx.fiber.dispose();
    }
  });

  it("refuses a stale reopened Create without creating another team after the operation completes", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    relay.noTeams.value = true;
    const storage = memoryStorage(),
      operation = crypto.randomUUID(),
      teamId = crypto.randomUUID();
    new TeamOps(storage).write({
      [operation]: {
        id: operation,
        teamId,
        owner: viewer,
        community: "https://relay.example.test",
        kind: "create",
        base: null,
        intent: {
          name: "Pending",
          instructions: "SAVED RULE",
          members: [alder],
        },
        commands: [],
        mode: "may-send",
        seq: 1,
      },
    });
    const f = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const config = relay.opens.mock.results[0]?.value;
      await config?.resumeTeams();
      relay.noTeams.value = false;
      await config?.resumeTeams();
      expect(new TeamOps(storage).every()).toEqual([]);
      // Another device edits the team after this one's change finished.
      const [created] = [...relay.heads.values()].filter((event) =>
        event.tags.some(([name, value]) => name === "team" && value === teamId),
      );
      if (!created) throw new Error("Missing created head");
      const remote = await signed(relay.owner, {
        kind: created.kind,
        created_at: created.created_at + 1,
        content: JSON.stringify({
          ...JSON.parse(created.content),
          instructions: "REMOTE RULE",
        }),
        tags: [
          ...created.tags.filter(([name]) => name !== "op" && name !== "prev"),
          ["op", "update"],
          ["prev", created.id],
        ],
      });
      relay.heads.set(
        [...relay.heads].find(([, event]) => event === created)?.[0] ?? "",
        remote,
      );
      const channelsBefore = relay.channels.size;
      await expect(
        f.service.saveTeam({
          creation: teamId,
          operation,
          name: "Revised",
          instructions: "NEW RULE",
          members: [alder],
        }),
      ).rejects.toThrow("changed on another device");
      expect([...relay.heads.values()]).toContain(remote);
      expect(readTeams(storage)).toEqual([]);
      expect(new TeamOps(storage).every()).toEqual([
        expect.objectContaining({ teamId, stop: "conflict" }),
      ]);
      expect(relay.channels.size).toBe(channelsBefore);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("revises a reopened change's stored record when Save removes every member, writing no local team", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    relay.noTeams.value = true;
    const storage = memoryStorage(),
      id = crypto.randomUUID(),
      teamId = crypto.randomUUID();
    new TeamOps(storage).write({
      [id]: {
        id,
        teamId,
        owner: viewer,
        community: "https://relay.example.test",
        kind: "create",
        base: null,
        intent: {
          name: "Pending",
          instructions: "SAVED RULE",
          members: [alder],
        },
        commands: [],
        mode: "may-send",
        seq: 1,
      },
    });
    const f = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      await f.service
        .saveTeam({
          creation: teamId,
          operation: id,
          name: "Revised",
          instructions: "NEW RULE",
          members: [],
        })
        .catch(() => {});
      const localCopies = readTeams(storage);
      expect(localCopies).toEqual([]);
      const [op] = new TeamOps(storage).every();
      expect(op?.intent.instructions).toBe("NEW RULE");
      expect(op?.intent.members).toEqual([]);
      expect(readTeams(storage)).toEqual([]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("finishes an archived unestablished move with Recover then Resubmit", async () => {
    const { f, relay, storage, config } = await heldMove();
    try {
      for (const c of relay.channels.values()) c.archived = true;
      await config.refreshTeams();
      await stopThen(f, "resubmit");
      const [op] = new TeamOps(storage).every();
      expect(op?.local).toBe("local-moving");
      expect(op?.stop).toBe("archived");
      await f.service.recoverTeam(op?.teamId ?? "");
      const stopped = f.service
        .snapshot()
        .teamChanges?.find((c) => c.kind === "move");
      expect(stopped).toBeDefined();
      await f.service.teamChange(stopped?.id ?? "", "resubmit");
      expect(new TeamOps(storage).every()).toEqual([]);
      expect(readTeams(storage)).toEqual([]);
      expect(count(await promptOf(f, "recover-move-exit"), "TEAM RULE")).toBe(
        1,
      );
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("finishes an unestablished move with no relay team through Resubmit", async () => {
    const { f, relay, storage, config } = await heldMove();
    try {
      relay.channels.clear();
      relay.heads.clear();
      relay.noTeams.value = false;
      await config.refreshTeams();
      await stopThen(f, "resubmit");
      expect(new TeamOps(storage).every()).toEqual([]);
      expect(readTeams(storage)).toEqual([]);
      expect(
        count(await promptOf(f, "missing-move-exit"), "LOCAL MOVING RULE"),
      ).toBe(1);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("keeps an unestablished move, its source and the relay head when Resubmit's team read fails", async () => {
    const { f, relay, storage, config } = await heldMove();
    try {
      const before = [...relay.heads.values()].map((h) => h.id);
      relay.failTeamReads.value = true;
      await config.refreshTeams();
      expect(config.teams()?.[0]?.unreadable).toBe(true);
      await stopThen(f, "resubmit");
      const [op] = new TeamOps(storage).every();
      expect(op).toMatchObject({
        kind: "move",
        local: "local-moving",
        mode: "may-send",
      });
      expect(op?.confirmedHead).toBeUndefined();
      expect(op?.candidate).toBeUndefined();
      expect(readTeams(storage)[0]?.instructions).toBe("LOCAL MOVING RULE");
      expect([...relay.heads.values()].map((h) => h.id)).toEqual(before);
      // The same durable handover remains after reload from storage.
      expect(new TeamOps(storage).every()[0]?.source?.kind).toBe("local-team");
      relay.failTeamReads.value = false;
      await f.service.teamChange(op?.id ?? "", "check");
      expect(new TeamOps(storage).every()).toEqual([]);
      expect(readTeams(storage)).toEqual([]);
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("keeps a stopped archived move across a restart, with neither copy in the prompt", async () => {
    const { f, relay, storage, config } = await heldMove();
    let restarted: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      for (const c of relay.channels.values()) c.archived = true;
      await config.refreshTeams();
      await stopThen(f, "dismiss");
      await f.ctx.fiber.dispose();
      restarted = await setup({ storage, identities: [here(alder)] });
      await vi.waitFor(() =>
        expect(restarted?.service.find(alder)?.configBase).toBeDefined(),
      );
      await relay.opens.mock.results.at(-1)?.value.refreshTeams();
      expect(new TeamOps(storage).every()).toHaveLength(1);
      expect(readTeams(storage)[0]?.instructions).toBe("LOCAL MOVING RULE");
      const prompt = await promptOf(restarted, "restart-archived-move");
      expect(prompt).not.toContain("LOCAL MOVING RULE");
      expect(prompt).not.toContain("TEAM RULE");
    } finally {
      if (restarted) await restarted.ctx.fiber.dispose();
      else await f.ctx.fiber.dispose();
    }
  });

  it("refuses Dismiss for an unestablished move before the team list loads", async () => {
    const relay = configRelay(async () => {
      throw new Error("discovery unavailable");
    });
    communityFake.value = relay.opens;
    relay.noTeams.value = true;
    const storage = memoryStorage(),
      id = crypto.randomUUID(),
      teamId = crypto.randomUUID();
    writeTeams(storage, [
      {
        id: "unknown-list-local",
        name: "Local",
        instructions: "LOCAL MOVING RULE",
        members: [alder],
      },
    ]);
    new TeamOps(storage).write({
      [id]: {
        id,
        teamId,
        owner: viewer,
        community: "https://relay.example.test",
        kind: "move",
        local: "unknown-list-local",
        source: { kind: "local-team", id: "unknown-list-local" },
        intent: {
          name: "Pending",
          instructions: "LOCAL MOVING RULE",
          members: [alder],
        },
        commands: [],
        mode: "reconcile-only",
        stop: "discarded",
        seq: 1,
      },
    });
    const f = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      const config = relay.opens.mock.results[0]?.value;
      expect(config?.teams()).toBeUndefined();
      await expect(f.service.teamChange(id, "dismiss")).rejects.toThrow(
        "can't be dismissed",
      );
      expect(new TeamOps(storage).every()).toHaveLength(1);
      expect(readTeams(storage)[0]?.instructions).toBe("LOCAL MOVING RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("revises a reopened pending Create's stored change after a restart, never adding a second", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    relay.noTeams.value = true;
    const storage = memoryStorage();
    const id = crypto.randomUUID(),
      teamId = crypto.randomUUID();
    new TeamOps(storage).write({
      [id]: {
        id,
        teamId,
        owner: viewer,
        community: "https://relay.example.test",
        kind: "create",
        base: null,
        intent: {
          name: "Pending",
          instructions: "SAVED RULE",
          members: [alder],
        },
        commands: [],
        mode: "may-send",
        seq: 1,
      },
    });
    const f = await setup({ storage, identities: [here(alder)] });
    try {
      await vi.waitFor(() =>
        expect(f.service.find(alder)?.configBase).toBeDefined(),
      );
      // Exactly the Save submitted by the reopened no-card TeamEditor.
      await f.service
        .saveTeam({
          creation: teamId,
          operation: id,
          name: "Revised",
          instructions: "NEW RULE",
          members: [alder],
        })
        .catch(() => {});
      const records = new TeamOps(storage)
        .every()
        .filter((op) => op.teamId === teamId);
      expect(records).toHaveLength(1);
      expect(records[0]?.intent.instructions).toBe("NEW RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("with config sync on, keeps one relay copy after an established move's change is resubmitted", async () => {
    const { f, storage, establish } = await heldMove();
    try {
      await establish();
      await stopThen(f, "resubmit");
      // The resubmitted text is now the relay team's, the one copy.
      expect(readTeams(storage)).toEqual([]);
      const prompt = await promptOf(f, "resubmitted-move");
      expect(count(prompt, "LOCAL MOVING RULE")).toBe(1);
      expect(prompt).not.toContain("TEAM RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("with config sync on, keeps a move's change and its handover when its local row can't be retired", async () => {
    const { f, storage, establish } = await heldMove();
    try {
      await establish();
      const setItem = storage.setItem.bind(storage);
      storage.setItem = (key: string, value: string) => {
        if (key === TEAMS_KEY) throw new Error("full");
        setItem(key, value);
      };
      await stopThen(f, "dismiss");
      expect(f.service.snapshot().teamChanges).toHaveLength(1);
      expect(new TeamOps(storage).every()).toHaveLength(1);
      expect(readTeams(storage)).toEqual([
        expect.objectContaining({ instructions: "LOCAL MOVING RULE" }),
      ]);
      const prompt = await promptOf(f, "unretired-move");
      expect(count(prompt, "TEAM RULE")).toBe(1);
      expect(prompt).not.toContain("LOCAL MOVING RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it.each([
    ["archived", "dismiss"],
    ["archived", "resubmit"],
    ["unreadable", "dismiss"],
    ["unreadable", "resubmit"],
  ] as const)(
    "with config sync on, keeps an unestablished move's local row and record when its %s relay team's change is %sed",
    async (state, action) => {
      const { f, relay, storage, config } = await heldMove();
      try {
        expect(new TeamOps(storage).every()[0]?.confirmedHead).toBeUndefined();
        if (state === "archived")
          for (const channel of relay.channels.values())
            channel.archived = true;
        else relay.heads.clear();
        await config.refreshTeams();
        await stopThen(f, action);
        if (state === "unreadable" && action === "resubmit") {
          // This fake reads an unreadable team as empty: the resubmitted
          // move creates it atomically, establishing it, so the relay copy
          // is the one copy and the row retires.
          expect(new TeamOps(storage).every()).toEqual([]);
          expect(readTeams(storage)).toEqual([]);
          expect(
            [...relay.heads.values()].map((head) => head.content).join(),
          ).toContain("LOCAL MOVING RULE");
          return;
        }
        expect(new TeamOps(storage).every()).toHaveLength(1);
        expect(readTeams(storage)).toEqual([
          expect.objectContaining({ instructions: "LOCAL MOVING RULE" }),
        ]);
        if (state === "unreadable") return; // An unreadable team blocks runs.
        const prompt = await promptOf(f, `${state}-${action}-move`);
        expect(prompt).not.toContain("LOCAL MOVING RULE");
        expect(prompt).not.toContain("TEAM RULE");
      } finally {
        await f.ctx.fiber.dispose();
      }
    },
  );

  it.each(["dismiss", "resubmit"] as const)(
    "with config sync on, gives a run one copy after an unestablished move with a readable relay team is %sed",
    async (action) => {
      const { f, storage } = await heldMove();
      try {
        expect(new TeamOps(storage).every()[0]?.confirmedHead).toBeUndefined();
        await stopThen(f, action);
        // Dismiss refuses and keeps the row; Resubmit's move adopts the
        // team, establishing it, and retires the row.
        expect(readTeams(storage)).toEqual(
          action === "dismiss"
            ? [expect.objectContaining({ instructions: "LOCAL MOVING RULE" })]
            : [],
        );
        const prompt = await promptOf(f, `readable-${action}-move`);
        expect(
          count(prompt, "LOCAL MOVING RULE") + count(prompt, "TEAM RULE"),
        ).toBe(1);
      } finally {
        await f.ctx.fiber.dispose();
      }
    },
  );

  it("with config sync on, dismissing a stopped established move never restores the local prompt copy", async () => {
    const { f, establish, config } = await heldMove();
    try {
      await establish();
      const change = f.service.snapshot().teamChanges?.[0];
      if (!change || !config) throw new Error("no unfinished move");
      await f.service.teamChange(change.id, "discard");
      await f.service.teamChange(change.id, "check");
      expect(f.service.snapshot().teamChanges?.[0]?.unresolved).toBe(false);
      await f.service.teamChange(change.id, "dismiss");
      mentionAlder(f, "dismissed-move");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      const prompt = f.run.mock.calls[0]?.[0].team;
      expect(count(prompt, "TEAM RULE")).toBe(1);
      expect(prompt).not.toContain("LOCAL MOVING RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("with config sync on, gives a run exactly one copy of a team during a held move", async () => {
    const { f, establish } = await heldMove();
    try {
      // Not established yet: the local row is the one copy.
      mentionAlder(f, "pending");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      const before = f.run.mock.calls[0]?.[0].team;
      expect(count(before, "LOCAL MOVING RULE")).toBe(1);
      expect(before).not.toContain("TEAM RULE");
      // Established, still unfinished: the relay copy is.
      await establish();
      mentionAlder(f, "established");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
      const after = f.run.mock.calls[1]?.[0].team;
      expect(count(after, "TEAM RULE")).toBe(1);
      expect(after).not.toContain("LOCAL MOVING RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("with config sync on, gives a run neither copy of a held move whose relay team is deleted", async () => {
    const { f, relay } = await heldMove();
    try {
      const config = relay.opens.mock.results[0]?.value;
      for (const channel of relay.channels.values()) channel.archived = true;
      await config?.refreshTeams();
      mentionAlder(f, "archived");
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      const team = f.run.mock.calls[0]?.[0].team ?? "";
      expect(team).not.toContain("LOCAL MOVING RULE");
      expect(team).not.toContain("TEAM RULE");
    } finally {
      await f.ctx.fiber.dispose();
    }
  });

  it("with config sync on, keeps a held move's relay copy when the community disconnects during model selection", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selecting = vi.fn(() => gate);
    const { f, establish } = await heldMove({ models: selecting });
    try {
      await establish();
      f.emit({
        events: [
          event("disconnect-during-pick", {
            pubkey: viewer,
            tags: [
              ["h", channel],
              ["p", alder],
              ["model", alder, "fast"],
            ],
          }),
        ],
        channelId: channel,
      });
      await vi.waitFor(() => expect(selecting).toHaveBeenCalledTimes(1));
      f.connect(false);
      expect(f.service.snapshot().running).toEqual([]);
      release();
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      const team = f.run.mock.calls[0]?.[0].team;
      expect(count(team, "TEAM RULE")).toBe(1);
      expect(team).not.toContain("LOCAL MOVING RULE");
    } finally {
      release();
      await f.ctx.fiber.dispose();
    }
  });

  it("with config sync on, deletes a synced team by archiving its channel, and recovers it", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    const { id } = await f.service.saveTeam({
      name: "Core",
      instructions: "",
      members: [alder],
    });
    const [channel] = [...relay.channels.values()];
    await f.service.removeTeam(id);
    expect(channel?.archived).toBe(true);
    expect(f.service.snapshot().teams).toEqual([]);
    expect(f.service.snapshot().archivedTeams).toEqual([
      expect.objectContaining({ id }),
    ]);
    await f.service.recoverTeam(id);
    expect(channel?.archived).toBe(false);
    expect(f.service.snapshot().teams).toEqual([
      expect.objectContaining({ id, members: [alder] }),
    ]);
    expect(f.service.snapshot().archivedTeams).toEqual([]);
    await f.ctx.fiber.dispose();
  });

  it("with config sync on, leaves hosted agents out of config sync", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    const { type, remote } = cloud();
    f.plugin.agents.register(type);
    await f.service.create({ type: "example/cloud", name: "Sky" });
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    await settle();
    expect(relay.heads.size).toBe(1);
    expect(relay.addMember).toHaveBeenCalledWith(
      expect.any(String),
      alder,
      expect.anything(),
    );
    expect(relay.addMember).not.toHaveBeenCalledWith(
      expect.anything(),
      hostedKey,
      expect.anything(),
    );
    expect(f.service.find(hostedKey)?.configBase).toBeUndefined();
    // Delete stays the provider's, never an archive in config channels.
    await f.service.remove(hostedKey);
    expect(remote.remove).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: hostedKey }),
    );
    await f.ctx.fiber.dispose();
  });

  async function syncedGoose() {
    const { GooseRuntime, DEFAULT_CONFIG } = await import(
      "../../bundled/goose/runtime"
    );
    const { gooseRun } = await import("../../bundled/goose/run");
    const { fakeSpawn } = await import("../../bundled/goose/goose-testing");
    const relay = configRelay();
    communityFake.value = relay.opens;
    const storage = memoryStorage();
    const process = fakeSpawn();
    let relayData: ReturnType<typeof fakeRelay>["relay"] | undefined;
    const runtime = new GooseRuntime(
      { spawn: process.spawn, serveMcp: process.serve } as never,
      () => relayData,
      async () => null,
      storage,
    );
    const f = await setup({
      storage,
      identities: [{ ...here(bot), type: "example/goose" }],
      extraType: {
        id: "goose",
        title: "Goose",
        defaults: () => ({
          config: {
            ...DEFAULT_CONFIG,
            workspace: "/tmp/review-goose",
            instructions: "CONFIG A",
            model: "model-a",
          },
        }),
        ...gooseRun(runtime),
      },
    });
    relayData = f.relay;
    Object.assign(f.session, {
      profiles: { ensure: async () => {}, snapshot: () => new Map() },
      names: { resolve: () => "Owner" },
    });
    const sync = () =>
      runtime.sync(
        f.service.snapshot().running.filter((a) => a.type === "example/goose"),
      );
    const off = f.service.subscribe(sync);
    sync();
    await vi.waitFor(() =>
      expect(f.service.find(bot)?.configBase?.instructions).toBeTruthy(),
    );
    await relay.opens.mock.results[0]?.value.reconnected();
    const first = event("1".repeat(64), {
      pubkey: viewer,
      tags: [
        ["h", channel],
        ["p", bot],
      ],
      created_at: Math.floor(Date.now() / 1000) + 1,
    });
    const deliver = (id: string) =>
      f.emit({
        events: [
          {
            ...first,
            id: id.padEnd(64, "0"),
            tags: [...first.tags, ["e", first.id, "", "reply"]],
          },
        ],
        channelId: channel,
      });
    f.emit({ events: [first], channelId: channel });
    await vi.waitFor(() => expect(process.geese[0]?.turns).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.sessions(bot)[0]?.busy).toBe(false));
    expect(
      process.geese[0]?.prompts.get(
        process.geese[0]?.turns[0]?.sessionId ?? "",
      ),
    ).toContain("CONFIG A");
    const save = (model = "model-b", instructions = "CONFIG B") => {
      const agent = f.service.find(bot);
      if (!agent) throw new Error("no agent");
      return f.service.save(bot, {
        config: {
          ...(agent.config as object),
          instructions,
          model,
        },
        ...(agent.configBase ? { base: agent.configBase } : {}),
      });
    };
    return {
      f,
      relay,
      storage,
      runtime,
      process,
      deliver,
      save,
      close: async () => {
        off();
        runtime.dispose();
        await f.ctx.fiber.dispose();
      },
    };
  }

  it("applies an accepted synced Save through the real Goose subscription and next turn", async () => {
    const g = await syncedGoose();
    let accept!: () => void;
    g.relay.held.value = new Promise((resolve) => {
      accept = resolve;
    });
    try {
      const before = g.relay.publishing.mock.calls.length;
      const saving = g.save();
      await vi.waitFor(() =>
        expect(g.relay.publishing.mock.calls.length).toBeGreaterThan(before),
      );
      accept();
      await saving;
      g.deliver("2".repeat(64));
      await vi.waitFor(() => expect(g.process.geese[0]?.turns).toHaveLength(2));
      expect(
        g.process.geese[0]?.prompts.get(
          g.process.geese[0]?.turns[1]?.sessionId ?? "",
        ),
      ).toContain("CONFIG B");
      expect(g.runtime.outdated(bot, g.f.service.find(bot)?.config)).toBe(
        false,
      );
    } finally {
      accept();
      await g.close();
    }
  });

  it("keeps a newer local draft when an earlier Save is accepted", async () => {
    const g = await syncedGoose();
    let accept!: () => void;
    g.relay.held.value = new Promise((resolve) => {
      accept = resolve;
    });
    try {
      const before = g.relay.publishing.mock.calls.length;
      const savingB = g.save("model-a");
      await vi.waitFor(() =>
        expect(g.relay.publishing.mock.calls.length).toBeGreaterThan(before),
      );
      // Edited again while B is unconfirmed, from the same opened head.
      const savingC = g.save("model-a", "CONFIG C");
      const refusal = expect(savingC).rejects.toThrow("kept as a draft");
      accept();
      await savingB;
      await refusal;
      // B is the head now, but C is still this device's stored draft.
      expect(g.storage.getItem("buzz.agents.v1")).toContain("CONFIG C");
    } finally {
      accept();
      g.relay.held.value = undefined;
      await g.close();
    }
  });

  it.each([
    ["direct", "instructions"],
    ["reconnect", "instructions"],
    ["direct", "settings"],
    ["reconnect", "settings"],
  ])(
    "applies accepted Save B while retaining draft C on %s for %s",
    async (mode, side) => {
      const g = await syncedGoose();
      let accept!: () => void;
      let reject!: (e: Error) => void;
      g.relay.held.value = new Promise((yes, no) => {
        accept = yes;
        reject = no;
      });
      try {
        const seen: unknown[] = [];
        const off = g.f.service.subscribe(() =>
          seen.push(g.f.service.find(bot)?.config),
        );
        const before = g.relay.publishing.mock.calls.length;
        const savingB =
          side === "instructions"
            ? g.save("model-a")
            : g.save("model-b", "CONFIG A");
        const refusalB =
          mode === "reconnect" ? expect(savingB).rejects.toThrow() : undefined;
        await vi.waitFor(() =>
          expect(g.relay.publishing.mock.calls.length).toBeGreaterThan(before),
        );
        if (mode === "reconnect") {
          reject(new Error("connection lost"));
          await refusalB;
        }
        const savingC =
          side === "instructions"
            ? g.save("model-a", "CONFIG C")
            : g.save("model-c", "CONFIG A");
        const refusalC = expect(savingC).rejects.toThrow();
        if (mode === "direct") accept();
        else {
          const beforeC = g.relay.publishing.mock.calls.length;
          await vi.waitFor(() =>
            expect(g.relay.publishing.mock.calls.length).toBeGreaterThan(
              beforeC,
            ),
          );
          reject(new Error("connection lost again"));
        }
        if (mode === "direct") await savingB;
        await refusalC;
        g.relay.held.value = undefined;
        if (mode === "reconnect")
          await g.relay.opens.mock.results[0]?.value.reconnected();
        expect(g.storage.getItem("buzz.agents.v1")).toContain(
          side === "instructions" ? "CONFIG C" : "model-c",
        );
        const shown = g.f.service.find(bot)?.config as {
          instructions: string;
          model: string;
        };
        if (side === "instructions")
          expect(shown.instructions).toBe("CONFIG B");
        else expect(shown.model).toBe("model-b");
        off();
        for (const value of seen) {
          const view = value as { instructions?: string; model?: string };
          expect(view.instructions).not.toBe("CONFIG C");
          expect(view.model).not.toBe("model-c");
        }
        g.deliver("4".repeat(64));
        await vi.waitFor(() =>
          expect(g.process.geese[0]?.turns).toHaveLength(2),
        );
        const prompt = g.process.geese[0]?.prompts.get(
          g.process.geese[0]?.turns[1]?.sessionId ?? "",
        );
        if (side === "instructions") {
          expect(prompt).toContain("CONFIG B");
          expect(prompt).not.toContain("CONFIG C");
        } else {
          expect(
            g.process.geese[0]?.configured.some((change) =>
              change.endsWith("model=model-b"),
            ),
          ).toBe(true);
          expect(
            g.process.geese[0]?.configured.some((change) =>
              change.endsWith("model=model-c"),
            ),
          ).toBe(false);
          expect(g.runtime.outdated(bot, shown)).toBe(false);
        }
      } finally {
        accept();
        g.relay.held.value = undefined;
        await g.close();
      }
    },
  );

  it("applies a History revert in an existing Goose conversation", async () => {
    const g = await syncedGoose();
    try {
      const first = g.f.service
        .configHistory(bot)
        ?.sides.find((s) => s.side === "instructions")?.head;
      if (!first) throw new Error("no original head");
      await g.save("model-a");
      g.deliver("5".repeat(64));
      await vi.waitFor(() => expect(g.process.geese[0]?.turns).toHaveLength(2));
      await vi.waitFor(() =>
        expect(g.runtime.sessions(bot)[0]?.busy).toBe(false),
      );
      expect(
        g.process.geese[0]?.prompts.get(
          g.process.geese[0]?.turns[1]?.sessionId ?? "",
        ),
      ).toContain("CONFIG B");
      const history = g.f.service.configHistory(bot);
      const side = history?.sides.find((s) => s.side === "instructions");
      if (!history || !side?.head) throw new Error("no History");
      expect(
        await history.revise(
          "instructions",
          revertTemplate(side.expected, side.head, first),
        ),
      ).toEqual({ status: "accepted" });
      expect(
        (g.f.service.find(bot)?.config as { instructions?: string } | undefined)
          ?.instructions,
      ).toBe("CONFIG A");
      g.deliver("6".repeat(64));
      await vi.waitFor(() => expect(g.process.geese[0]?.turns).toHaveLength(3));
      expect(
        g.process.geese[0]?.prompts.get(
          g.process.geese[0]?.turns[2]?.sessionId ?? "",
        ),
      ).toContain("CONFIG A");
    } finally {
      await g.close();
    }
  });

  it("never overlays draft C onto an accepted settings head that omits a setting", async () => {
    const g = await syncedGoose();
    let accept!: () => void;
    g.relay.held.value = new Promise((resolve) => {
      accept = resolve;
    });
    try {
      const opened = g.f.service.find(bot);
      const historyBefore = g.f.service.configHistory(bot);
      const settingsBefore = historyBefore?.sides.find(
        (side) => side.side === "settings",
      );
      if (!opened || !historyBefore || !settingsBefore?.head)
        throw new Error("no agent settings History");
      const body = JSON.parse(settingsBefore.head.content);
      delete body.settings.model;
      body.settings.scope = "channel";
      const before = g.relay.publishing.mock.calls.length;
      const savingB = historyBefore.revise(
        "settings",
        artifactTemplate({
          ...settingsBefore.expected,
          title: "Settings",
          content: JSON.stringify(body),
          op: "update",
          prev: settingsBefore.head.id,
        }),
      );
      await vi.waitFor(() =>
        expect(g.relay.publishing.mock.calls.length).toBeGreaterThan(before),
      );
      const savingC = g.f.service.save(bot, {
        config: {
          ...(opened.config as object),
          scope: "channel",
          model: "model-c",
        },
        ...(opened.configBase ? { base: opened.configBase } : {}),
      });
      const refusal = expect(savingC).rejects.toThrow("kept as a draft");
      accept();
      expect(await savingB).toEqual({ status: "accepted" });
      await refusal;
      expect(g.storage.getItem("buzz.agents.v1")).toContain("model-c");
      const history = g.f.service
        .configHistory(bot)
        ?.sides.find((side) => side.side === "settings");
      expect(
        JSON.parse(history?.head?.content ?? "{}").settings,
      ).not.toHaveProperty("model");
      const shown = g.f.service.find(bot)?.config as { model?: string };
      // Complete an actual next turn before inspecting the process boundary.
      g.deliver("a".repeat(64));
      await vi.waitFor(() => expect(g.process.geese[0]?.turns).toHaveLength(2));
      await vi.waitFor(() =>
        expect(g.runtime.sessions(bot)[0]?.busy).toBe(false),
      );
      expect.soft(shown.model).not.toBe("model-c");
      expect
        .soft(
          g.process.geese[0]?.configured.some((change) =>
            change.endsWith("model=model-c"),
          ),
        )
        .toBe(false);
    } finally {
      accept();
      g.relay.held.value = undefined;
      await g.close();
    }
  });

  it("applies a settings History revert and direct revise to an existing Goose conversation", async () => {
    const g = await syncedGoose();
    const next = async (id: string, model: string) => {
      const count = g.process.geese[0]?.turns.length ?? 0;
      g.deliver(id.repeat(64));
      await vi.waitFor(() =>
        expect(g.process.geese[0]?.turns).toHaveLength(count + 1),
      );
      await vi.waitFor(() =>
        expect(g.runtime.sessions(bot)[0]?.busy).toBe(false),
      );
      expect(g.process.geese[0]?.configured.at(-1)).toMatch(
        new RegExp(`model=${model}$`),
      );
    };
    try {
      const first = g.f.service
        .configHistory(bot)
        ?.sides.find((s) => s.side === "settings")?.head;
      if (!first) throw new Error("no settings head");
      await g.save("model-b", "CONFIG A");
      await next("7", "model-b");
      const history = g.f.service.configHistory(bot);
      const side = history?.sides.find((s) => s.side === "settings");
      if (!history || !side?.head) throw new Error("no History");
      expect(
        await history.revise(
          "settings",
          revertTemplate(side.expected, side.head, first, history.settings),
        ),
      ).toEqual({ status: "accepted" });
      await next("8", "model-a");
      const updated = g.f.service
        .configHistory(bot)
        ?.sides.find((s) => s.side === "settings");
      if (!updated?.head) throw new Error("no updated head");
      expect(
        await history.revise(
          "settings",
          artifactTemplate({
            ...updated.expected,
            title: "Settings",
            content: JSON.stringify({
              ...JSON.parse(updated.head.content),
              settings: {
                ...JSON.parse(updated.head.content).settings,
                model: "model-d",
              },
            }),
            op: "update",
            prev: updated.head.id,
          }),
        ),
      ).toEqual({ status: "accepted" });
      await next("9", "model-d");
    } finally {
      await g.close();
    }
  });

  it("does not consume more local-save tokens on settled reconnects", async () => {
    const g = await syncedGoose();
    try {
      await g.save();
      const accepted = g.f.service.find(bot)?.saves;
      const config = g.relay.opens.mock.results[0]?.value;
      await config.reconnected();
      await config.reconnected();
      expect(g.f.service.find(bot)?.saves).toBe(accepted);
    } finally {
      await g.close();
    }
  });

  it("applies a held synced Save to an existing Goose conversation when reconnect accepts it", async () => {
    const g = await syncedGoose();
    let reject!: (error: Error) => void;
    g.relay.held.value = new Promise((_, no) => {
      reject = no;
    });
    try {
      const before = g.relay.publishing.mock.calls.length;
      const saving = g.save("model-a");
      const refusal = expect(saving).rejects.toThrow();
      await vi.waitFor(() =>
        expect(g.relay.publishing.mock.calls.length).toBeGreaterThan(before),
      );
      reject(new Error("connection lost before acceptance"));
      await refusal;
      g.relay.held.value = undefined;
      const config = g.relay.opens.mock.results[0]?.value;
      await config.reconnected();
      const accepted = g.f.service.find(bot)?.config as
        | { instructions?: string }
        | undefined;
      expect(accepted?.instructions).toBe("CONFIG B");
      g.deliver("3".repeat(64));
      await vi.waitFor(() => expect(g.process.geese[0]?.turns).toHaveLength(2));
      expect(
        g.process.geese[0]?.prompts.get(
          g.process.geese[0]?.turns[1]?.sessionId ?? "",
        ),
      ).toContain("CONFIG B");
      expect(g.runtime.outdated(bot, g.f.service.find(bot)?.config)).toBe(
        false,
      );
    } finally {
      g.relay.held.value = undefined;
      await g.close();
    }
  });

  it("with config sync on, advances an agent's local-save token once the relay accepts its Save", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    await vi.waitFor(() =>
      expect(f.service.find(alder)?.configBase).toBeDefined(),
    );
    /** Each view a runtime's sync would see: its local-save token and the
     * instructions it would run on. */
    const seen: [string, unknown][] = [];
    const unsubscribe = f.service.subscribe(() => {
      const agent = f.service.find(alder);
      if (agent)
        seen.push([
          localKey(agent),
          (agent.config as { instructions?: unknown }).instructions,
        ]);
    });
    const agent = f.service.find(alder);
    if (!agent?.configBase) throw new Error("not synced");
    const before = (agent.config as { instructions?: unknown }).instructions;
    let accept!: () => void;
    relay.held.value = new Promise((resolve) => {
      accept = resolve;
    });
    const saving = f.service.save(alder, {
      config: { ...(agent.config as object), instructions: "SAVED HERE" },
      base: agent.configBase,
    });
    await settle();
    accept();
    await saving;
    unsubscribe();
    expect(seen.at(-1)?.[1]).toBe("SAVED HERE");
    // The token the saved config arrives with is not one a runtime already
    // used up on the old config.
    const spent = seen
      .filter(([, instructions]) => instructions === before)
      .map(([key]) => key);
    expect(spent).not.toContain(seen.at(-1)?.[0]);
    await f.ctx.fiber.dispose();
  });

  it("with config sync on, restores a deleted synced side from History, and refuses a stale one", async () => {
    const relay = configRelay();
    communityFake.value = relay.opens;
    const f = await setup({ identities: [here(alder)] });
    await vi.waitFor(() =>
      expect(f.service.configHistory(alder)?.sides).toHaveLength(1),
    );
    const history = f.service.configHistory(alder);
    const side = history?.sides[0];
    const first = side?.head;
    if (!history || !side || !first) throw new Error("no History");
    expect(side.side).toBe("instructions");
    // Another device deletes the instructions.
    const removal = artifactTemplate({
      ...side.expected,
      op: "update",
      prev: first.id,
      title: "Agent instructions",
      content: "{}",
    });
    const deleted = await signed(keypair(), {
      ...removal,
      content: "",
      tags: removal.tags.map((tag) =>
        tag[0] === "op" ? ["op", "delete"] : tag,
      ),
    });
    relay.heads.set(side.expected.d, deleted);
    const store = (f.service as unknown as { configStore: AgentConfigStore })
      .configStore;
    const subject = (
      f.service as unknown as {
        syncedBinding(agent: unknown): { instructions?: { subject: Subject } };
      }
    ).syncedBinding(f.service.find(alder))?.instructions?.subject;
    if (!subject) throw new Error("not synced");
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: deleted,
    });
    expect(f.service.configHistory(alder)?.sides[0]?.head?.id).toBe(deleted.id);
    const restore = revertTemplate(side.expected, deleted, first);
    expect(await history.revise("instructions", restore)).toEqual({
      status: "accepted",
    });
    const restored = f.service.configHistory(alder)?.sides[0]?.head;
    expect(restored?.tags).toContainEqual(["op", "restore"]);
    expect(restored?.content).toBe(first.content);
    // A History still showing the deletion builds on a head that moved on.
    expect(await history.revise("instructions", restore)).toEqual({
      status: "refused",
      message: "This config changed on another device",
    });
    await f.ctx.fiber.dispose();
  });

  it("says Delete failed when the archive was definitely refused", async () => {
    const config = fakeConfig();
    config.life.next = "active";
    communityFake.value = config;
    const f = await setup();
    await f.service.create({ type: "example/echo", name: "Echo" });
    await vi.waitFor(() => expect(config.resume).toHaveBeenCalled());
    await expect(f.service.remove(bot)).rejects.toThrow(
      "Echo couldn't be deleted. Try again.",
    );
    await f.ctx.fiber.dispose();
  });
});
