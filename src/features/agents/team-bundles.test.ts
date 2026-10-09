import { afterEach, expect, it, vi } from "vitest";
import * as communityApi from "../communities/api";
import { createAgentControl } from "./control";
import { controlFixture } from "./control-testing";
import {
  importTeamMembers,
  resumeTeamImport,
  type TeamSnapshot,
} from "./team-bundles";
const snapshot: TeamSnapshot = {
  format: "buzz-team-snapshot",
  version: 1,
  team: { name: "Fixture team", instructions: "TEAM_MARKER" },
  members: ["One", "Two"].map((name) => ({
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name,
      systemPrompt: `INDIVIDUAL_${name}`,
      runtime: "buzz-agent",
    },
    profile: { displayName: name },
    memory: { level: "none", entries: [] },
  })),
};
it("retains identity requests on partial failure, preserves separate instructions and never starts", async () => {
  const fixture = controlFixture();
  fixture.data.agents = [];
  fixture.data.defaultWorkspace = "/fixture/workspace";
  const saved = new Map<string, typeof fixture.agent>();
  let failSecond = true;
  fixture.host.prepareCreate = vi.fn(async (request) => {
    const previous = saved.get(request);
    return previous
      ? { id: previous.id, pubkey: previous.pubkey, saved: true }
      : { id: request, pubkey: (request === "one" ? "ab" : "cd").repeat(32) };
  });
  fixture.host.commitCreate = vi.fn(async (request, edit, _auth, bundle) => {
    expect(bundle?.instructions).toBe("TEAM_MARKER");
    expect(edit.systemPrompt).toBe(
      `INDIVIDUAL_${request === "one" ? "One" : "Two"}`,
    );
    expect(edit.environment).toEqual({});
    if (request === "two" && failSecond)
      throw new Error("Fixture credential failure");
    const agent = {
      ...fixture.agent,
      id: request,
      pubkey: (request === "one" ? "ab" : "cd").repeat(32),
      status: "stopped" as const,
      enabled: false,
      profilePending: false,
    };
    saved.set(request, agent);
    fixture.data.agents = [...saved.values()];
    return structuredClone(fixture.data);
  });
  const community = vi.fn(async () => ({
    auth: ["auth", "ef".repeat(32), "", "fixture-signature"],
  }));
  vi.spyOn(communityApi, "communityRequest").mockImplementation(community);
  const control = createAgentControl(fixture.host);
  await control.refresh();
  await expect(
    importTeamMembers(
      control,
      snapshot,
      ["one", "two"],
      "https://relay.example.test",
      "ef".repeat(32),
      false,
      "team-a",
    ),
  ).rejects.toThrow("Could not confirm");
  expect(saved.size).toBe(1);
  failSecond = false;
  const imported = await importTeamMembers(
    control,
    snapshot,
    ["one", "two"],
    "https://relay.example.test",
    "ef".repeat(32),
    false,
    "team-a",
  );
  expect(imported.map((agent) => agent.id)).toEqual(["one", "two"]);
  expect(new Set(imported.map((agent) => agent.pubkey)).size).toBe(2);
  expect(fixture.host.commitCreate).toHaveBeenCalledTimes(3);
  expect(vi.mocked(fixture.host.commitCreate).mock?.calls[0]?.[3]).toEqual(
    expect.objectContaining({
      team: "team-a",
      instructions: snapshot.team.instructions,
    }),
  );
  expect(community).toHaveBeenCalledTimes(3);
  expect(
    fixture.calls.filter((call) => ["start", "profile"].includes(call.action)),
  ).toEqual([]);
  control.dispose();
});
it("rejects unavailable local runtime before creating any identity", async () => {
  const fixture = controlFixture();
  fixture.data.harnessOptions = [];
  fixture.host.prepareCreate = vi.fn();
  fixture.host.commitCreate = vi.fn();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  await expect(
    importTeamMembers(
      control,
      snapshot,
      ["one", "two"],
      "https://relay.example.test",
      "ef".repeat(32),
      false,
      "team-a",
    ),
  ).rejects.toThrow("unavailable");
  expect(fixture.host.prepareCreate).not.toHaveBeenCalled();
  control.dispose();
});

it("forwards explicit memory export selection while defaulting to team only", async () => {
  const fixture = controlFixture();
  fixture.host.exportTeam = vi.fn(async () => snapshot);
  const control = createAgentControl(fixture.host);
  expect(
    await control.exportTeam?.(
      snapshot,
      ["one", "two"],
      "https://relay.example",
    ),
  ).toBe(snapshot);
  expect(fixture.host.exportTeam).toHaveBeenLastCalledWith(
    snapshot,
    ["one", "two"],
    "https://relay.example",
    "none",
  );
  expect(
    await control.exportTeam?.(
      snapshot,
      ["one", "two"],
      "https://relay.example",
      "core",
    ),
  ).toBe(snapshot);
  expect(fixture.host.exportTeam).toHaveBeenLastCalledWith(
    snapshot,
    ["one", "two"],
    "https://relay.example",
    "core",
  );
  expect(
    await control.exportTeam?.(
      snapshot,
      ["one", "two"],
      "https://relay.example",
      "everything",
    ),
  ).toBe(snapshot);
  expect(fixture.host.exportTeam).toHaveBeenLastCalledWith(
    snapshot,
    ["one", "two"],
    "https://relay.example",
    "everything",
  );
  control.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("resumes public receipts after remount without storing prompts or memories", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const first = await resumeTeamImport(
    snapshot,
    "https://relay.example",
    "owner",
  );
  const resumed = await resumeTeamImport(
    structuredClone(snapshot),
    "https://relay.example",
    "owner",
  );
  expect(resumed.id).toBe(first.id);
  expect(resumed.requests).toEqual(first.requests);
  expect([...values.values()].join("")).not.toContain("TEAM_MARKER");
  expect([...values.values()].join("")).not.toContain("INDIVIDUAL_");
  expect(
    (await resumeTeamImport(snapshot, "https://other.example", "owner"))
      .requests,
  ).not.toEqual(first.requests);
  expect(
    (await resumeTeamImport(snapshot, "https://relay.example", "other-owner"))
      .requests,
  ).not.toEqual(first.requests);
  expect(
    (
      await resumeTeamImport(
        snapshot,
        "https://relay.example",
        "owner",
        "",
        true,
      )
    ).requests,
  ).not.toEqual(first.requests);
  resumed.complete();
  expect(
    (await resumeTeamImport(snapshot, "https://relay.example", "owner"))
      .requests,
  ).not.toEqual(first.requests);
});

it.each([
  ["claude", "/local/claude-agent-acp"],
  ["hermes", "/local/hermes-acp"],
  ["pi", "/local/buzz-pi-acp"],
  ["goose", "/local/goose-acp"],
] as const)(
  "uses shared local %s mapping and preserves original receipt settings",
  async (runtime, command) => {
    const fixture = controlFixture();
    fixture.data.harnessOptions = [
      {
        command,
        available: true,
        label: runtime,
        status: "ready",
        defaultArgs: [],
        providers: [],
      },
    ];
    const source = snapshot.members[0];
    if (!source) throw new Error("Missing fixture member");
    const member = structuredClone(source);
    member.definition = {
      ...member.definition,
      runtime,
      parallelism: 3,
      respondTo: "allowlist",
      respondToAllowlist: ["ef".repeat(32)],
      namePool: ["One"],
      idleTimeoutSeconds: 30,
      maxTurnDurationSeconds: 60,
    };
    member.profile.about = "Portable description";
    const created = { ...fixture.agent, id: "copy" };
    const create = vi.fn<
      NonNullable<import("./control").AgentControl["create"]>
    >(async () => created);
    const control = {
      refresh: vi.fn(async () => {}),
      snapshot: () => ({ data: fixture.data }),
      create,
    } as unknown as import("./control").AgentControl;
    await importTeamMembers(
      control,
      { ...snapshot, members: [member] },
      ["request"],
      "https://relay.example",
      "ef".repeat(32),
      true,
      "team-a",
    );
    expect(create).toHaveBeenCalledWith(
      "request",
      "https://relay.example",
      "ef".repeat(32),
      expect.objectContaining({
        harness: expect.objectContaining({ command }),
        environment: {},
      }),
      expect.objectContaining({ member, team: "team-a", keepAllowlist: true }),
    );
    delete member.definition.parallelism;
    await importTeamMembers(
      control,
      { ...snapshot, members: [member] },
      ["omitted"],
      "https://relay.example",
      "ef".repeat(32),
      false,
      "team-a",
    );
    expect(create.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ environment: {} }),
    );
  },
);

it.each(["claude", "hermes", "pi"])(
  "rejects invalid %s selectors before any team identity is created",
  async (runtime) => {
    const fixture = controlFixture();
    fixture.data.harnessOptions = [
      {
        command: `${runtime === "claude" ? "claude-agent" : runtime === "pi" ? "buzz-pi" : runtime}-acp`,
        available: true,
        label: runtime,
        status: "ready",
        defaultArgs: [],
        providers: [],
      },
    ];
    const source = snapshot.members[0];
    if (!source) throw new Error("Missing fixture member");
    const member = structuredClone(source);
    member.definition = {
      ...member.definition,
      runtime,
      provider: "unsupported",
      model: "",
    };
    const create = vi.fn();
    const control = {
      refresh: vi.fn(async () => {}),
      snapshot: () => ({ data: fixture.data }),
      create,
    } as unknown as import("./control").AgentControl;
    await expect(
      importTeamMembers(
        control,
        { ...snapshot, members: [member] },
        ["second"],
        "https://relay.example",
        "ef".repeat(32),
        false,
        "team-a",
      ),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it("validates optional memories before stripping them for creation and preserves the source", async () => {
  const fixture = controlFixture();
  const source = structuredClone(snapshot);
  const member = source.members[0];
  if (!member) throw new Error("Missing fixture member");
  member.memory = {
    level: "everything",
    entries: Array.from({ length: 256 }, (_, index) => ({
      slug: `mem/memory-${index}`,
      body: "Optional memory",
    })),
  };
  const create = vi.fn<NonNullable<import("./control").AgentControl["create"]>>(
    async () => fixture.agent,
  );
  const control = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ data: fixture.data }),
    create,
  } as unknown as import("./control").AgentControl;
  await importTeamMembers(
    control,
    source,
    ["one", "two"],
    "https://relay.example",
    "ef".repeat(32),
    false,
    "team-a",
  );
  expect(create.mock.calls[0]?.[4]).toEqual(
    expect.objectContaining({
      member: { ...member, memory: { level: "none", entries: [] } },
    }),
  );
  expect(member.memory.entries).toHaveLength(256);
});

it("preflights every member before creating a valid first member", async () => {
  const fixture = controlFixture();
  const source = structuredClone(snapshot);
  const second = source.members[1];
  if (!second) throw new Error("Missing fixture member");
  second.definition.runtime = "unsupported";
  const create = vi.fn();
  const control = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ data: fixture.data }),
    create,
  } as unknown as import("./control").AgentControl;
  await expect(
    importTeamMembers(
      control,
      source,
      ["one", "two"],
      "https://relay.example",
      "ef".repeat(32),
      false,
      "team-a",
    ),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
