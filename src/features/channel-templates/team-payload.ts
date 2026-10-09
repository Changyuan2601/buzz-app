import type { TeamSnapshot } from "../agents/team-bundles.ts";

export const TEAM_PAYLOAD_TAG = "buzz-team-payload-v1";
export const TEAM_MANIFEST_TAG = "buzz-channel-kit-v2";
export const TEAM_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const TEAM_CHUNK_BYTES = 16 * 1024;
export const TEAM_CHUNKS = TEAM_PAYLOAD_BYTES / TEAM_CHUNK_BYTES;
export interface TeamManifest {
  version: 1;
  owner: string;
  revision: string;
  digest: string;
  bytes: number;
  chunks: number;
}
export interface TeamPayload {
  version: 1;
  community: string;
  owner: string;
  teamId: string;
  revision: string;
  index: number;
  data: string;
}
const hexKey = /^[0-9a-f]{64}$/;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const revision = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function parseTeamManifest(raw: unknown): TeamManifest {
  const value = raw as TeamManifest | undefined;
  if (
    value?.version !== 1 ||
    !hexKey.test(value.owner) ||
    !revision.test(value.revision) ||
    !hexKey.test(value.digest) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > TEAM_PAYLOAD_BYTES ||
    value.chunks !== Math.ceil(value.bytes / TEAM_CHUNK_BYTES)
  )
    throw new Error("Invalid portable team manifest");
  return {
    version: 1,
    owner: value.owner,
    revision: value.revision,
    digest: value.digest,
    bytes: value.bytes,
    chunks: value.chunks,
  };
}
export function parseTeamPayload(raw: unknown, community: string): TeamPayload {
  const value = raw as TeamPayload | undefined;
  if (
    value?.version !== 1 ||
    value.community !== community ||
    !hexKey.test(value.owner) ||
    !identifier.test(value.teamId) ||
    !revision.test(value.revision) ||
    !Number.isSafeInteger(value.index) ||
    value.index < 0 ||
    value.index >= TEAM_CHUNKS ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(TEAM_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    )
  )
    throw new Error("Invalid portable team payload");
  return {
    version: 1,
    community,
    owner: value.owner,
    teamId: value.teamId,
    revision: value.revision,
    index: value.index,
    data: value.data,
  };
}
export function payloadCoordinate(
  value: Omit<TeamPayload, "data" | "version">,
) {
  return `${TEAM_PAYLOAD_TAG}:${encodeURIComponent(value.community)}:${value.owner}:${value.teamId}:${value.revision}:${value.index}`;
}
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Only portable configuration travels to persistence; memory is restored separately. */
export function withoutTeamMemories(snapshot: TeamSnapshot): TeamSnapshot {
  return {
    ...snapshot,
    members: snapshot.members.map((member) => ({
      ...member,
      memory: { level: "none", entries: [] },
    })),
  };
}
export async function encodeTeamPayload(
  snapshot: TeamSnapshot,
  community: string,
  owner: string,
  teamId: string,
  operationRevision: string = crypto.randomUUID(),
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(withoutTeamMemories(snapshot)),
  );
  if (!bytes.length || bytes.length > TEAM_PAYLOAD_BYTES)
    throw new Error("Team snapshot exceeds the size limit");
  const manifest = parseTeamManifest({
    version: 1,
    owner,
    revision: operationRevision,
    digest: await digest(bytes),
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / TEAM_CHUNK_BYTES),
  });
  const payloads: TeamPayload[] = [];
  for (let index = 0; index < manifest.chunks; index++) {
    const chunk = bytes.subarray(
      index * TEAM_CHUNK_BYTES,
      (index + 1) * TEAM_CHUNK_BYTES,
    );
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    payloads.push(
      parseTeamPayload(
        {
          version: 1,
          community,
          owner,
          teamId,
          revision: manifest.revision,
          index,
          data: btoa(binary),
        },
        community,
      ),
    );
  }
  return { manifest, payloads };
}
/** Host decode already verifies signature/owner. Check every immutable binding before JSON. */
export async function decodeTeamPayload(
  manifestValue: TeamManifest,
  payloads: readonly TeamPayload[],
  community: string,
  owner: string,
  teamId: string,
): Promise<unknown> {
  const manifest = parseTeamManifest(manifestValue);
  if (manifest.owner !== owner || payloads.length !== manifest.chunks)
    throw new Error("Incomplete portable team payload");
  const bytes = new Uint8Array(manifest.bytes);
  for (let index = 0; index < payloads.length; index++) {
    const payload = parseTeamPayload(payloads[index], community);
    if (
      payload.owner !== owner ||
      payload.teamId !== teamId ||
      payload.revision !== manifest.revision ||
      payload.index !== index
    )
      throw new Error("Portable team revision mismatch");
    const binary = atob(payload.data);
    const expected = Math.min(
      TEAM_CHUNK_BYTES,
      manifest.bytes - index * TEAM_CHUNK_BYTES,
    );
    if (binary.length !== expected || btoa(binary) !== payload.data)
      throw new Error("Invalid portable team chunk size");
    bytes.set(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
      index * TEAM_CHUNK_BYTES,
    );
  }
  if ((await digest(bytes)) !== manifest.digest)
    throw new Error("Portable team integrity check failed");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
