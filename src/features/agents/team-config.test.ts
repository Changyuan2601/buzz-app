import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import type { RelayWriter } from "../relay/transport";
import { AgentConfigStore } from "./agent-config";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  type SnapshotRead,
} from "./agent-config-artifacts";
import { importedTeamId, teamSubject } from "./config-channels";
import { MigrationJournal } from "./config-writes";
import {
  discoverTeams,
  editTeam,
  publishTeam,
  retired,
  TEAMS_MIGRATION_KEY,
  TeamJournal,
  teamCommunity,
} from "./team-config";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const community = "wss://relay.example";
const communityId = "5b0c2f9e-3d1a-4c7b-9e8f-1a2b3c4d5e6f";
const teamChannel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const a = keypair().pubkey;
const b = keypair().pubkey;
const team = { name: "Core", instructions: "Ship it.", members: [a, b] };

function setup(
  options: { archived?: boolean; agents?: string[]; existing?: boolean } = {},
) {
  const storage = memoryStorage();
  const state = { head: undefined as RelayEvent | undefined };
  const sent: RelayEvent[] = [];
  const journalAtSend: string[] = [];
  const read: SnapshotRead = async () => (state.head ? [state.head] : []);
  const writer: RelayWriter = {
    sign: vi.fn(async (template) => signed(owner, template)),
    async publish(event) {
      journalAtSend.push(storage.getItem(TEAMS_MIGRATION_KEY) ?? "");
      sent.push(event);
      const prev = event.tags.find((t) => t[0] === "prev")?.[1];
      if (!state.head || prev === state.head.id) state.head = event;
    },
  };
  const agents = new Set(options.agents ?? [a, b]);
  const channels = {
    find: vi.fn(async (family: string, subject: string) => {
      if (family === "agent-config")
        return agents.has(subject)
          ? { id: `agent-${subject}`, archived: false }
          : undefined;
      return options.archived || options.existing
        ? { id: teamChannel, archived: !!options.archived }
        : undefined;
    }),
    ensure: vi.fn(async () => ({ id: teamChannel, archived: false })),
    addMember: vi.fn(async () => ({ status: "confirmed" as const })),
    removeMember: vi.fn(async () => ({ status: "confirmed" as const })),
    owns: vi.fn(async (pubkey: string) => agents.has(pubkey)),
    teams: vi.fn(
      async (): Promise<
        { id: string; archived: boolean; label: string; members?: string[] }[]
      > => [],
    ),
  };
  const store = new AgentConfigStore(storage);
  const journal = new TeamJournal(storage);
  const deps = {
    channels,
    sync: { bind: vi.fn(async () => {}) },
    writes: {
      read,
      writer,
      store,
      journal: new MigrationJournal(storage),
      maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
      signal: new AbortController().signal,
    },
    journal,
    owner: owner.pubkey,
    community,
    communityId: communityId as string | undefined,
  };
  return {
    deps,
    sent,
    state,
    store,
    channels,
    journal,
    agents,
    storage,
    journalAtSend,
  };
}

const source = { kind: "local-team", id: "beta-abc" } as const;

describe("team migration", () => {
  it("publishes a local team under its UUIDv5 import id, journaled before any write", async () => {
    const f = setup();
    const entry = await publishTeam(f.deps, source, team);
    // The community's UUID, never its relay origin (§6.3).
    const id = await importedTeamId({
      owner: owner.pubkey,
      community: communityId,
      source: "local-team",
      sourceId: "beta-abc",
    });
    expect(entry).toMatchObject({
      status: "confirmed",
      teamId: id,
      channelId: teamChannel,
      addedMembers: [a, b],
    });
    expect(f.channels.ensure).toHaveBeenCalledWith(
      "team-config",
      await teamSubject(id),
      "Core",
      expect.anything(),
    );
    expect(f.sent[0]?.tags).toContainEqual(["team", id]);
    expect(f.sent[0]?.tags).toContainEqual([
      "imported-from",
      "local-team:beta-abc",
    ]);
    expect(f.journalAtSend[0]).toContain(id);
    expect(retired(entry as never)).toBe(true);
  });

  it("moves no imported or local team while the community's UUID is unknown", async () => {
    const f = setup();
    const entry = await publishTeam(
      { ...f.deps, communityId: undefined },
      { kind: "old-buzz-team", id: "old-1" },
      team,
    );
    expect(entry.status).toBe("unsupported");
    expect(f.channels.ensure).not.toHaveBeenCalled();
    expect(f.journal.all()).toEqual([]);
  });

  it("gives every device and every rerun the same team id", async () => {
    const one = await publishTeam(setup().deps, source, team);
    const two = await publishTeam(setup().deps, source, team);
    expect((one as { teamId: string }).teamId).toBe(
      (two as { teamId: string }).teamId,
    );
    expect((one as { teamId: string }).teamId).toHaveLength(36);
  });

  it("installs an invalid team head as invalid, never present", async () => {
    const f = setup({ existing: true });
    f.state.head = await signed(owner, {
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
        ["team", "another-team"],
      ],
    });
    await publishTeam(f.deps, source, team);
    expect(f.sent).toHaveLength(0);
    const id = (f.journal.get(community, "beta-abc") as { teamId: string })
      .teamId;
    expect(
      f.store.state({
        owner: owner.pubkey,
        community,
        subject: id,
        channel: teamChannel,
        type: "buzz.team",
      }),
    ).toMatchObject({
      state: "invalid",
      problem: "Team does not match this config channel",
    });
  });

  it("keeps a member without an agent channel pending, then adds it on retry", async () => {
    const f = setup({ agents: [a] });
    const first = await publishTeam(f.deps, source, team);
    expect(first).toMatchObject({ addedMembers: [a], pendingMembers: [b] });
    expect(retired(first as never)).toBe(true);
    f.agents.add(b);
    const second = await publishTeam(f.deps, source, team);
    expect(second).toMatchObject({ addedMembers: [a, b], pendingMembers: [] });
    expect(f.sent).toHaveLength(1);
  });

  it("offers Recover for an archived copy and never creates a second one", async () => {
    const f = setup({ archived: true });
    expect(await publishTeam(f.deps, source, team)).toEqual({
      status: "archived",
      teamId: expect.any(String),
      channelId: teamChannel,
    });
    expect(f.channels.ensure).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it("keeps a team whose members span communities local", () => {
    const where = { [a]: "one", [b]: "two" } as Record<string, string>;
    expect(teamCommunity(team, (p) => where[p])).toBe("spans");
    expect(teamCommunity(team, () => "one")).toBe("one");
  });
});

describe("synced teams", () => {
  async function published() {
    const f = setup();
    const entry = (await publishTeam(
      f.deps,
      { kind: "new", id: "t-1" },
      team,
    )) as {
      teamId: string;
    };
    f.channels.teams.mockResolvedValue([
      {
        id: teamChannel,
        archived: false,
        label: await teamSubject(entry.teamId),
        members: [owner.pubkey, a, b],
      },
    ]);
    return f;
  }

  it("discovers a team by the id its channel label proves, and binds it", async () => {
    const f = await published();
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
    const f = await published();
    f.channels.teams.mockResolvedValue([
      { id: teamChannel, archived: false, label: await teamSubject("other") },
    ]);
    f.storage.removeItem(TEAMS_MIGRATION_KEY);
    expect(
      await discoverTeams({ ...f.deps, journal: new TeamJournal(f.storage) }),
    ).toEqual([]);
  });

  it("keeps a known team whose head can't be read as unreadable, with its members", async () => {
    const f = await published();
    const [known] = await discoverTeams(f.deps);
    f.deps.writes.read = async () => {
      throw new Error("relay down");
    };
    expect(await discoverTeams(f.deps, known ? [known] : [])).toMatchObject([
      { id: "t-1", unreadable: true, members: [a, b] },
    ]);
    // Only the journal knows it, as after a restart.
    expect(await discoverTeams(f.deps)).toMatchObject([
      { id: "t-1", unreadable: true, members: [a, b] },
    ]);
  });

  it("counts only agents this owner attests to as members, and never removes anyone else", async () => {
    const f = await published();
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
    if (!found) throw new Error("no team");
    await editTeam(f.deps, found, { ...team, members: [] });
    expect(f.channels.removeMember).toHaveBeenCalledTimes(2);
    expect(f.channels.removeMember).toHaveBeenCalledWith(teamChannel, a);
    expect(f.channels.removeMember).toHaveBeenCalledWith(teamChannel, b);
  });

  it("refuses a stale team editor after a remote edit", async () => {
    const f = await published();
    const [found] = await discoverTeams(f.deps);
    if (!found) throw new Error("no team");
    const opened = { ...team, name: "My rename" };
    expect(
      (await editTeam(f.deps, found, { ...team, instructions: "REMOTE RULE" }))
        .saved?.status,
    ).toBe("saved");
    const result = await editTeam(f.deps, found, opened);
    expect(result.saved?.status).toBe("conflict");
  });

  it("does not confirm uncertain membership changes", async () => {
    const f = await published();
    const [found] = await discoverTeams(f.deps);
    if (!found) throw new Error("no team");
    f.channels.removeMember.mockResolvedValue({ status: "uncertain" } as never);
    const result = await editTeam(f.deps, found, { ...team, members: [a] });
    expect(result.failed).toEqual([b]);
  });

  it("saves an edit as a team revision and changes membership by diff", async () => {
    const f = await published();
    const [found] = await discoverTeams(f.deps);
    if (!found) throw new Error("no team");
    const result = await editTeam(f.deps, found, {
      name: "Core",
      instructions: "Ship carefully.",
      members: [a],
    });
    expect(result.saved?.status).toBe("saved");
    expect(f.sent[1]?.tags).toContainEqual(["team", "t-1"]);
    expect(f.sent[1]?.tags).toContainEqual(["prev", f.sent[0]?.id]);
    expect(f.channels.removeMember).toHaveBeenCalledWith(teamChannel, b);
    expect(f.channels.addMember).toHaveBeenCalledTimes(2);
  });
});
