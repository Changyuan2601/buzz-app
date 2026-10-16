import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import { artifactD, artifactTemplate } from "./agent-config-artifacts";
import { teamSubject } from "./config-channels";
import {
  discoverTeams,
  TEAMS_MIGRATION_KEY,
  TeamJournal,
  teamCommunity,
} from "./team-config";
import { type TeamOp, TeamOps } from "./team-ops";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const community = "wss://relay.example";
const teamChannel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const teamId = "0f6a3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b";
const a = keypair().pubkey;
const b = keypair().pubkey;

const head = async (claimed = teamId) =>
  signed(
    owner,
    artifactTemplate({
      channel: teamChannel,
      type: "buzz.team",
      d: await artifactD("buzz.team", teamChannel),
      team: claimed,
      title: "Core",
      content: JSON.stringify({ version: 1, name: "Core", instructions: "x" }),
      op: "create",
      extra: [["team", claimed]],
    }),
  );

async function setup(members = [owner.pubkey, a, b]) {
  const storage = memoryStorage();
  const state = { head: (await head()) as RelayEvent | undefined };
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
          label: await teamSubject(teamId),
          members,
        },
      ],
    ),
  };
  const ops = new TeamOps(storage);
  const deps = {
    channels,
    sync: { bind: vi.fn(async () => {}) },
    writes: {
      read: vi.fn(async () => (state.head ? [state.head] : [])),
      signal: new AbortController().signal,
    },
    ops,
    owner: owner.pubkey,
    community,
  };
  return { deps, state, channels, ops, storage };
}

describe("synced teams", () => {
  it("keeps a team whose members span communities local", () => {
    const team = { members: [a, b] };
    const where = { [a]: "one", [b]: "two" } as Record<string, string>;
    expect(teamCommunity(team, (p) => where[p])).toBe("spans");
    expect(teamCommunity(team, () => "one")).toBe("one");
  });

  it("discovers a team by the id its channel label proves, and binds it", async () => {
    const f = await setup();
    const [found] = await discoverTeams(f.deps);
    expect(found).toMatchObject({
      id: teamId,
      channel: teamChannel,
      unreadable: false,
      members: [a, b],
    });
    expect(f.deps.sync.bind).toHaveBeenLastCalledWith([
      { family: "team-config", subject: teamId, channel: teamChannel },
    ]);
  });

  it("skips a team channel whose head claims a team its label doesn't prove", async () => {
    const f = await setup();
    f.state.head = await head("another-team");
    expect(await discoverTeams(f.deps)).toEqual([]);
  });

  it("names an unreadable channel by the team change that made it", async () => {
    const f = await setup();
    f.state.head = undefined;
    f.ops.write({
      op1: {
        id: "op1",
        owner: owner.pubkey,
        community,
        teamId,
        channel: teamChannel,
        seq: 1,
        commands: [],
      } as unknown as TeamOp,
    });
    expect(await discoverTeams(f.deps)).toMatchObject([
      { id: teamId, unreadable: true },
    ]);
  });

  it("keeps a known team whose head can't be read as unreadable, with its members", async () => {
    const f = await setup();
    const [known] = await discoverTeams(f.deps);
    f.deps.writes.read = vi.fn(async () => {
      throw new Error("relay down");
    });
    expect(await discoverTeams(f.deps, known ? [known] : [])).toMatchObject([
      { id: teamId, unreadable: true, members: [a, b] },
    ]);
  });

  it("counts only agents this owner attests to as members", async () => {
    const human = keypair().pubkey;
    const f = await setup([owner.pubkey, a, human, b]);
    const [found] = await discoverTeams(f.deps);
    expect(found?.members).toEqual([a, b]);
  });

  it("remembers discovered teams per owner and community, across restarts", async () => {
    const f = await setup();
    const teams = await discoverTeams(f.deps);
    new TeamJournal(f.storage).remember(owner.pubkey, community, teams);
    const journal = new TeamJournal(f.storage);
    expect(journal.known(owner.pubkey, community)).toMatchObject([
      { id: teamId, subject: { subject: teamId, channel: teamChannel } },
    ]);
    expect(journal.known(owner.pubkey, "wss://other.example")).toBeUndefined();
    expect(journal.synced(teamId)).toBe(true);
    expect(journal.synced("local-id")).toBe(false);
    f.storage.setItem(TEAMS_MIGRATION_KEY, "{bad");
    expect(new TeamJournal(f.storage).synced(teamId)).toBe(false);
  });
});
