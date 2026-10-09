import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import { importTeamMembers, type TeamSnapshot } from "./team-bundles";
import { importTeamSnapshot } from "./team-import";
vi.mock("./team-bundles", async (original) => ({
  ...(await original<typeof import("./team-bundles")>()),
  importTeamMembers: vi.fn(),
}));
const snapshot: TeamSnapshot = {
  format: "buzz-team-snapshot",
  version: 1,
  team: { name: "Fixture", description: "Purpose", instructions: "TEAM" },
  members: [
    {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: { name: "One", systemPrompt: "INDIVIDUAL" },
      profile: { displayName: "One" },
      memory: {
        level: "core",
        entries: [{ slug: "core", body: "SAFE_MEMORY" }],
      },
    },
  ],
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.mocked(importTeamMembers).mockResolvedValue([
    { id: "copy", pubkey: "a".repeat(64) },
  ] as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function fixture() {
  const writeSnapshotMemory = vi.fn(async () => ({
    written: 1,
    total: 1,
    errors: [] as string[],
  }));
  const control = {
    previewTeam: vi.fn(async () => structuredClone(snapshot)),
    writeSnapshotMemory,
  } as unknown as AgentControl;
  const savePortable = vi.fn();
  const kit = {
    refresh: vi.fn(),
    snapshot: () => ({ entries: [] }),
    savePortable,
  } as unknown as ChannelKit;
  return { control, kit, writeSnapshotMemory, savePortable };
}
it("imports memory-bearing definitions without restoring memory unless explicitly requested", async () => {
  const { control, kit, writeSnapshotMemory, savePortable } = fixture();
  const result = await importTeamSnapshot(control, kit, snapshot, {
    destination: "https://relay.example",
    owner: "b".repeat(64),
    keepAllowlist: false,
  });
  expect(importTeamMembers).toHaveBeenCalledWith(
    control,
    snapshot,
    expect.any(Array),
    "https://relay.example",
    "b".repeat(64),
    false,
    result.id,
  );
  expect(writeSnapshotMemory).not.toHaveBeenCalled();
  expect(result.memories).toEqual([]);
  expect(savePortable.mock.calls[0]?.[1].team).toEqual(snapshot.team);
  expect(result.agents[0]?.pubkey).toBe("a".repeat(64));
});
it("retains the same creation requests on memory failure and reports per-member retry outcomes", async () => {
  const { control, kit, writeSnapshotMemory } = fixture();
  writeSnapshotMemory.mockResolvedValueOnce({
    written: 0,
    total: 1,
    errors: ["not confirmed"],
  });
  const options = {
    destination: "https://relay.example",
    owner: "b".repeat(64),
    keepAllowlist: false,
    restoreMemory: true,
  };
  const first = await importTeamSnapshot(control, kit, snapshot, options);
  const second = await importTeamSnapshot(control, kit, snapshot, options);
  expect(first.id).toBe(second.id);
  expect(vi.mocked(importTeamMembers).mock.calls[0]?.[2]).toEqual(
    vi.mocked(importTeamMembers).mock.calls[1]?.[2],
  );
  expect(first.memories).toEqual([
    { pubkey: "a".repeat(64), written: 0, total: 1, errors: ["not confirmed"] },
  ]);
  expect(second.memories[0]?.written).toBe(1);
  expect(writeSnapshotMemory).toHaveBeenCalledWith(
    "copy",
    snapshot.members[0]?.memory.entries,
  );
});
