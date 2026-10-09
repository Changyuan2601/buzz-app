import { expect, it } from "vitest";
import type { TeamSnapshot } from "../agents/team-bundles";
import {
  decodeTeamPayload,
  encodeTeamPayload,
  payloadCoordinate,
  TEAM_CHUNK_BYTES,
} from "./team-payload";
const owner = "ab".repeat(32);
const community = "https://relay.example";
const snapshot: TeamSnapshot = {
  format: "buzz-team-snapshot",
  version: 1,
  team: {
    name: "Fixture",
    description: "Keep description",
    instructions: "TEAM".repeat(TEAM_CHUNK_BYTES),
  },
  members: [
    {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: { name: "One", systemPrompt: "INDIVIDUAL" },
      profile: { displayName: "One" },
      memory: {
        level: "core",
        entries: [{ slug: "core", body: "PRIVATE_MEMORY" }],
      },
    },
  ],
};
it("round trips multiple chunks without losing definitions or persisting memory", async () => {
  const { manifest, payloads } = await encodeTeamPayload(
    snapshot,
    community,
    owner,
    "team",
  );
  expect(payloads.length).toBeGreaterThan(1);
  const result = await decodeTeamPayload(
    manifest,
    payloads,
    community,
    owner,
    "team",
  );
  expect(result).toEqual({
    ...snapshot,
    members: snapshot.members.map((member) => ({
      ...member,
      memory: { level: "none", entries: [] },
    })),
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_MEMORY");
  expect(new Set(payloads.map(payloadCoordinate)).size).toBe(payloads.length);
});
it("rejects missing, reordered, altered and foreign-revision chunks", async () => {
  const { manifest, payloads } = await encodeTeamPayload(
    snapshot,
    community,
    owner,
    "team",
  );
  await expect(
    decodeTeamPayload(manifest, payloads.slice(1), community, owner, "team"),
  ).rejects.toThrow("Incomplete");
  await expect(
    decodeTeamPayload(
      manifest,
      [...payloads].reverse(),
      community,
      owner,
      "team",
    ),
  ).rejects.toThrow("revision mismatch");
  await expect(
    decodeTeamPayload(manifest, payloads, community, "cd".repeat(32), "team"),
  ).rejects.toThrow("Incomplete");
  await expect(
    decodeTeamPayload(manifest, payloads, community, owner, "other-team"),
  ).rejects.toThrow("revision mismatch");
  await expect(
    decodeTeamPayload(
      manifest,
      payloads,
      "https://other.example",
      owner,
      "team",
    ),
  ).rejects.toThrow("Invalid");
  const altered = structuredClone(payloads);
  const firstChunk = altered[0];
  if (!firstChunk) throw new Error("Missing fixture chunk");
  firstChunk.data = btoa("a".repeat(TEAM_CHUNK_BYTES));
  await expect(
    decodeTeamPayload(manifest, altered, community, owner, "team"),
  ).rejects.toThrow("integrity");
  const other = await encodeTeamPayload(snapshot, community, owner, "team");
  await expect(
    decodeTeamPayload(manifest, other.payloads, community, owner, "team"),
  ).rejects.toThrow("revision mismatch");
});
it("binds retry chunks to the same explicit revision and rejects oversized snapshots", async () => {
  const revision = crypto.randomUUID();
  const first = await encodeTeamPayload(
    snapshot,
    community,
    owner,
    "team",
    revision,
  );
  expect(
    await encodeTeamPayload(snapshot, community, owner, "team", revision),
  ).toEqual(first);
  await expect(
    encodeTeamPayload(
      {
        ...snapshot,
        team: { name: "Large", instructions: "x".repeat(8 * 1024 * 1024) },
      },
      community,
      owner,
      "team",
    ),
  ).rejects.toThrow("size limit");
});
