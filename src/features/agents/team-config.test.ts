import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import { AgentConfigStore } from "./agent-config";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  type SnapshotRead,
} from "./agent-config-artifacts";
import { teamSubject } from "./config-channels";
import { MigrationJournal } from "./config-writes";
import { discoverTeams, TeamJournal } from "./team-config";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const community = "wss://relay.example";
const teamChannel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const a = keypair().pubkey;
const b = keypair().pubkey;

/** A team channel whose head is team `t-1`'s, with `a` and `b` in it. */
async function setup() {
  const storage = memoryStorage();
  const head: RelayEvent = await signed(owner, {
    kind: 45010,
    created_at: 1,
    content: JSON.stringify({ version: 1, name: "Core", instructions: "" }),
    tags: [
      ["ar", "1"],
      ["d", await artifactD("buzz.team", teamChannel)],
      ["h", teamChannel],
      ["type", "buzz.team"],
      ["title", "Core"],
      ["op", "create"],
      ["team", "t-1"],
    ],
  });
  const agents = new Set([a, b]);
  const channels = {
    owns: vi.fn(async (pubkey: string) => agents.has(pubkey)),
    teams: vi.fn(
      async (): Promise<
        { id: string; archived: boolean; label: string; members?: string[] }[]
      > => [
        {
          id: teamChannel,
          archived: false,
          label: await teamSubject("t-1"),
          members: [owner.pubkey, a, b],
        },
      ],
    ),
  };
  const read: SnapshotRead = async () => [head];
  const journal = new TeamJournal(storage);
  const deps = {
    channels,
    sync: { bind: vi.fn(async () => {}) },
    writes: {
      read,
      writer: {
        sign: vi.fn(async () => head),
        publish: vi.fn(async () => {}),
      },
      store: new AgentConfigStore(storage),
      journal: new MigrationJournal(storage),
      maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
      signal: new AbortController().signal,
    },
    journal,
    owner: owner.pubkey,
    community,
  };
  return { deps, channels, journal, storage };
}

describe("synced teams", () => {
  it("discovers a team by the id its channel label proves, and binds it", async () => {
    const f = await setup();
    const [found] = await discoverTeams(f.deps);
    expect(found).toMatchObject({
      id: "t-1",
      channel: teamChannel,
      members: [a, b],
    });
    expect(f.deps.sync.bind).toHaveBeenLastCalledWith([
      { family: "team-config", subject: "t-1", channel: teamChannel },
    ]);
  });

  it("skips a team channel whose head claims a team its label doesn't prove", async () => {
    const f = await setup();
    f.channels.teams.mockResolvedValue([
      { id: teamChannel, archived: false, label: await teamSubject("other") },
    ]);
    expect(await discoverTeams(f.deps)).toEqual([]);
  });

  it("keeps a known team whose head can't be read as unreadable, with its members", async () => {
    const f = await setup();
    const found = await discoverTeams(f.deps);
    f.journal.remember(owner.pubkey, community, found);
    f.deps.writes.read = async () => {
      throw new Error("relay down");
    };
    expect(await discoverTeams(f.deps, found)).toMatchObject([
      { id: "t-1", unreadable: true, members: [a, b] },
    ]);
    // Only the journal knows it, as after a restart.
    const known = new TeamJournal(f.storage).known(owner.pubkey, community);
    expect(await discoverTeams(f.deps, known)).toMatchObject([
      { id: "t-1", unreadable: true, members: [a, b] },
    ]);
    expect(await discoverTeams(f.deps)).toEqual([]);
  });

  it("counts only agents this owner attests to as members", async () => {
    const f = await setup();
    const human = keypair().pubkey;
    const theirs = keypair().pubkey;
    f.channels.teams.mockResolvedValue([
      {
        id: teamChannel,
        archived: false,
        label: await teamSubject("t-1"),
        members: [owner.pubkey, a, human, b, theirs],
      },
    ]);
    const [found] = await discoverTeams(f.deps);
    expect(found?.members).toEqual([a, b]);
  });

  it("knows a discovered team as synced on this device after a restart", async () => {
    const f = await setup();
    f.journal.remember(owner.pubkey, community, await discoverTeams(f.deps));
    const restarted = new TeamJournal(f.storage);
    expect(restarted.synced("t-1")).toBe(true);
    expect(restarted.synced("local-1")).toBe(false);
  });
});
