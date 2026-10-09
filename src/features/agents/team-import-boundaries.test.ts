import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import { controlFixture } from "./control-testing";
import { parseAgentSnapshot } from "./snapshot";
import type { TeamSnapshot } from "./team-bundles";
import { importTeamSnapshot } from "./team-import";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

function fixture(memoryCount = 0, body = "Memory") {
  const native = controlFixture();
  const source: TeamSnapshot = {
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: "Boundary team", instructions: "TEAM" },
    members: [
      {
        format: "buzz-agent-snapshot",
        version: 1,
        definition: {
          name: "One",
          runtime: "buzz-agent",
          systemPrompt: "INDIVIDUAL",
        },
        profile: { displayName: "One" },
        memory: {
          level: memoryCount ? "everything" : "none",
          entries: Array.from({ length: memoryCount }, (_, index) => ({
            slug: `mem/memory-${index}`,
            body,
          })),
        },
      },
    ],
  };
  const create = vi.fn<NonNullable<AgentControl["create"]>>(
    async () => native.agent,
  );
  // Model the native restore cap, not native HTTP/credential execution.
  const writeSnapshotMemory = vi.fn<
    NonNullable<AgentControl["writeSnapshotMemory"]>
  >(async (_id, entries) => {
    const rejected =
      entries.length > 128 ||
      entries.some(
        (entry) => new TextEncoder().encode(entry.body).length > 64 * 1024,
      );
    return {
      written: rejected ? 0 : entries.length,
      total: entries.length,
      errors: rejected ? ["Native memory restore limit"] : [],
    };
  });
  const control = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ data: native.data }),
    create,
    // Host preview is stubbed; exercise the real shared parser/importer after it.
    previewTeam: vi.fn(async () => structuredClone(source)),
    writeSnapshotMemory,
  } as unknown as AgentControl;
  const savePortable = vi.fn(async () => "saved");
  const kit = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ entries: [] }),
    savePortable,
  } as unknown as ChannelKit;
  return { source, control, kit, create, writeSnapshotMemory, savePortable };
}
const options = {
  destination: "https://relay.example",
  owner: "b".repeat(64),
  keepAllowlist: false,
};

it.each([128, 129, 256, 257])(
  "imports %i memory entries only within team limits and preserves explicit restore outcomes",
  async (count) => {
    for (const restoreMemory of [false, true]) {
      const f = fixture(count);
      if (count > 256) {
        await expect(
          importTeamSnapshot(f.control, f.kit, f.source, {
            ...options,
            restoreMemory,
          }),
        ).rejects.toThrow();
        expect(f.create).not.toHaveBeenCalled();
        expect(f.writeSnapshotMemory).not.toHaveBeenCalled();
        continue;
      }
      const first = await importTeamSnapshot(f.control, f.kit, f.source, {
        ...options,
        restoreMemory,
      });
      expect(f.create.mock.calls[0]?.[4]?.member.memory).toEqual({
        level: "none",
        entries: [],
      });
      expect(f.source.members[0]?.memory.entries).toHaveLength(count);
      if (!restoreMemory) {
        expect(f.writeSnapshotMemory).not.toHaveBeenCalled();
        expect(first.memories).toEqual([]);
      } else if (count > 128) {
        expect(first.memories[0]).toEqual(
          expect.objectContaining({
            written: 0,
            total: count,
            errors: ["Native memory restore limit"],
          }),
        );
        const second = await importTeamSnapshot(f.control, f.kit, f.source, {
          ...options,
          restoreMemory,
        });
        expect(second.id).toBe(first.id);
        expect(f.create.mock.calls[1]?.[0]).toBe(f.create.mock.calls[0]?.[0]);
      } else {
        expect(first.memories[0]).toEqual(
          expect.objectContaining({ written: count, total: count, errors: [] }),
        );
      }
    }
  },
);

it.each([64 * 1024, 64 * 1024 + 1])(
  "keeps %i-byte bodies independent of memory consent and reports restore refusal",
  async (bytes) => {
    for (const restoreMemory of [false, true]) {
      const f = fixture(1, "m".repeat(bytes));
      const first = await importTeamSnapshot(f.control, f.kit, f.source, {
        ...options,
        restoreMemory,
      });
      if (!restoreMemory) expect(f.writeSnapshotMemory).not.toHaveBeenCalled();
      else if (bytes > 64 * 1024) {
        expect(first.memories[0]?.errors).toEqual([
          "Native memory restore limit",
        ]);
        const second = await importTeamSnapshot(f.control, f.kit, f.source, {
          ...options,
          restoreMemory,
        });
        expect(second.id).toBe(first.id);
      } else expect(first.memories[0]?.written).toBe(1);
    }
  },
);

it.each([
  ["respondToAllowlist", 2000, true],
  ["respondToAllowlist", 2001, false],
  ["namePool", 256, true],
  ["namePool", 257, false],
] as const)(
  "preflights %s count %i before any copy",
  async (field, count, accepted) => {
    for (const restoreMemory of [false, true]) {
      const f = fixture();
      const member = f.source.members[0];
      if (!member) throw new Error("Missing fixture member");
      member.definition[field] = Array.from({ length: count }, (_, index) =>
        field === "namePool"
          ? `Name ${index}`
          : index.toString(16).padStart(64, "0"),
      );
      const operation = importTeamSnapshot(f.control, f.kit, f.source, {
        ...options,
        restoreMemory,
      });
      if (accepted) await operation;
      else {
        await expect(operation).rejects.toThrow();
        expect(f.create).not.toHaveBeenCalled();
      }
      expect(f.writeSnapshotMemory).not.toHaveBeenCalled();
    }
  },
);

it("includes slug bytes in the one-MiB memory aggregate", () => {
  const f = fixture(1, "m".repeat(1024 * 1024 - "mem/memory-0".length));
  const member = f.source.members[0];
  if (!member) throw new Error("Missing fixture member");
  const parse = () =>
    parseAgentSnapshot(new TextEncoder().encode(JSON.stringify(member)), {
      teamMember: true,
    });
  expect(parse).not.toThrow();
  const entry = member.memory.entries[0];
  if (!entry) throw new Error("Missing fixture memory");
  entry.body += "m";
  expect(parse).toThrow();
});
