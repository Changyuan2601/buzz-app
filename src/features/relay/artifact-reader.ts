import { eventDto, type RelayEvent } from "./events";
import { yieldToHost } from "./yield";

export const ARTIFACT_SYNC_LIMITS = Object.freeze({
  version: 1,
  overlapSeconds: 120,
  pageRows: 100,
  currentRows: 100,
  responseBytes: 8_388_608,
  permanentChannelsOnly: true,
  checkpointLifetimeSeconds: 2_592_000,
});
export type ArtifactSyncQuery = Readonly<{
  artifact: "current";
  kinds: readonly [45010];
  "#type": readonly string[];
}>;
export type ArtifactSyncChange =
  | Readonly<{ type: "upsert"; artifactId: string; event: RelayEvent }>
  | Readonly<{ type: "remove"; artifactId: string }>
  | Readonly<{ type: "removeChannel"; channelId: string }>;
export type ArtifactSyncPage = Readonly<{
  startedAt: string;
  overlapSeconds: 120;
  changes: readonly ArtifactSyncChange[];
  nextCursor: string | null;
  checkpoint: string | null;
}>;
export type ArtifactCurrentPage = Readonly<{
  startedAt: string;
  changes: readonly Exclude<ArtifactSyncChange, { type: "removeChannel" }>[];
}>;
export type ArtifactSyncRequest =
  | Readonly<{
      artifact: "sync";
      query: ArtifactSyncQuery;
      checkpoint?: string;
      cursor?: string;
    }>
  | Readonly<{
      artifact: "sync";
      action: "current";
      query: ArtifactSyncQuery;
      artifactIds: readonly string[];
    }>;
export type ArtifactSyncReader = {
  delta(
    query: ArtifactSyncQuery,
    position: { checkpoint?: string; cursor?: string },
    signal: AbortSignal,
  ): Promise<ArtifactSyncPage>;
  current(
    query: ArtifactSyncQuery,
    artifactIds: readonly string[],
    signal: AbortSignal,
  ): Promise<ArtifactCurrentPage>;
};
type ErrorCode =
  | "sync_invalid"
  | "sync_limit"
  | "sync_reset"
  | "sync_unavailable";
type ResetReason = "policy_changed" | "checkpoint_expired";
export class ArtifactSyncError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason?: ResetReason,
  ) {
    super(message);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const token = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value);
const invalid = () =>
  new ArtifactSyncError("sync_invalid", "Invalid artifact sync response");

export function artifactSyncFailure(value: unknown) {
  if (
    !object(value) ||
    !["sync_invalid", "sync_limit", "sync_reset", "sync_unavailable"].includes(
      String(value.code),
    ) ||
    (value.reason !== undefined &&
      value.reason !== "policy_changed" &&
      value.reason !== "checkpoint_expired")
  )
    return;
  return {
    error: "Artifact sync request fails",
    code: value.code as ErrorCode,
    ...(value.reason ? { reason: value.reason as ResetReason } : {}),
  };
}
export function artifactSyncCapability(info: unknown): boolean {
  if (!object(info) || !object(info.artifacts) || !object(info.artifacts.sync))
    return false;
  const sync = info.artifacts.sync;
  return Object.entries(ARTIFACT_SYNC_LIMITS).every(
    ([key, value]) => sync[key] === value,
  );
}
function queryType(query: ArtifactSyncQuery): string {
  if (
    !object(query) ||
    Object.keys(query).length !== 3 ||
    query.artifact !== "current" ||
    !Array.isArray(query.kinds) ||
    query.kinds.length !== 1 ||
    query.kinds[0] !== 45010 ||
    !Array.isArray(query["#type"]) ||
    query["#type"].length !== 1 ||
    typeof query["#type"][0] !== "string" ||
    !query["#type"][0].length
  )
    throw invalid();
  return query["#type"][0];
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    Number(parts[4]) < 24 &&
    Number(parts[5]) < 60 &&
    Number(parts[6]) < 60 &&
    Number(parts[7] ?? 0) < 24 &&
    Number(parts[8] ?? 0) < 60
  );
}
async function responseValue(response: Response, signal: AbortSignal) {
  if (!response.body) {
    signal.throwIfAborted();
    throw invalid();
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      if (bytes > ARTIFACT_SYNC_LIMITS.responseBytes)
        throw new ArtifactSyncError(
          "sync_limit",
          "Artifact sync response exceeds capacity",
        );
      text += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    const raw: unknown = JSON.parse(text);
    if (!response.ok) {
      const failure = artifactSyncFailure(raw);
      throw failure
        ? new ArtifactSyncError(failure.code, failure.error, failure.reason)
        : new ArtifactSyncError(
            "sync_unavailable",
            "Artifact sync request fails",
          );
    }
    return raw;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ArtifactSyncError) throw error;
    throw invalid();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function changes(
  raw: unknown,
  type: string,
  signal: AbortSignal,
  currentIds?: ReadonlySet<string>,
): Promise<readonly ArtifactSyncChange[]> {
  if (!Array.isArray(raw) || raw.length > ARTIFACT_SYNC_LIMITS.pageRows)
    throw invalid();
  const result: ArtifactSyncChange[] = [];
  for (const change of raw) {
    signal.throwIfAborted();
    if (!object(change)) throw invalid();
    if (change.type === "removeChannel" && uuid(change.channelId)) {
      result.push(
        Object.freeze({ type: change.type, channelId: change.channelId }),
      );
    } else if (
      change.type === "remove" &&
      typeof change.artifactId === "string" &&
      (currentIds ? currentIds.has(change.artifactId) : uuid(change.artifactId))
    ) {
      result.push(
        Object.freeze({ type: change.type, artifactId: change.artifactId }),
      );
    } else if (change.type === "upsert" && uuid(change.artifactId)) {
      let event: RelayEvent;
      try {
        event = eventDto(change.event);
      } catch {
        throw invalid();
      }
      const one = (name: string) => {
        const tags = event.tags.filter(([key]) => key === name);
        return tags.length === 1 && tags[0]?.length === 2
          ? tags[0][1]
          : undefined;
      };
      if (
        event.kind !== 45010 ||
        one("d") !== change.artifactId ||
        !uuid(one("h")) ||
        one("type") !== type ||
        one("ar") !== "1" ||
        !["create", "update", "move", "restore"].includes(one("op") ?? "")
      )
        throw invalid();
      result.push(
        Object.freeze({
          type: change.type,
          artifactId: change.artifactId,
          event,
        }),
      );
    } else throw invalid();
    if (result.length % 12 === 0) await yieldToHost();
  }
  signal.throwIfAborted();
  return Object.freeze(result);
}

/** Sync covers permanent channels only. The authenticated transport owns POST requests. */
export function createArtifactSyncReader(
  request: (
    filter: ArtifactSyncRequest,
    signal: AbortSignal,
  ) => Promise<Response>,
): ArtifactSyncReader {
  const send = async (filter: ArtifactSyncRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await request(filter, signal);
    } catch {
      signal.throwIfAborted();
      throw new ArtifactSyncError(
        "sync_unavailable",
        "Artifact sync request fails",
      );
    }
    const raw = await responseValue(response, signal);
    if (!object(raw) || raw.version !== 1 || !timestamp(raw.startedAt))
      throw invalid();
    return raw;
  };
  return {
    async delta(query, position, signal) {
      const type = queryType(query);
      if (
        (position.checkpoint !== undefined && position.cursor !== undefined) ||
        (position.checkpoint !== undefined && !token(position.checkpoint)) ||
        (position.cursor !== undefined && !token(position.cursor))
      )
        throw invalid();
      const raw = await send(
        {
          artifact: "sync",
          query,
          ...(position.checkpoint !== undefined
            ? { checkpoint: position.checkpoint }
            : {}),
          ...(position.cursor !== undefined ? { cursor: position.cursor } : {}),
        },
        signal,
      );
      if (
        raw.overlapSeconds !== 120 ||
        (raw.nextCursor !== null && !token(raw.nextCursor)) ||
        (raw.nextCursor === null
          ? !token(raw.checkpoint)
          : raw.checkpoint !== null)
      )
        throw invalid();
      return Object.freeze({
        startedAt: raw.startedAt as string,
        overlapSeconds: 120,
        changes: await changes(raw.changes, type, signal),
        nextCursor: raw.nextCursor as string | null,
        checkpoint: raw.checkpoint as string | null,
      });
    },
    async current(query, artifactIds, signal) {
      const type = queryType(query);
      if (
        !Array.isArray(artifactIds) ||
        !artifactIds.length ||
        artifactIds.length > ARTIFACT_SYNC_LIMITS.currentRows ||
        artifactIds.some(
          (id) =>
            typeof id !== "string" ||
            !id.length ||
            new TextEncoder().encode(id).byteLength > 256,
        ) ||
        new Set(artifactIds).size !== artifactIds.length
      )
        throw invalid();
      const raw = await send(
        { artifact: "sync", action: "current", query, artifactIds },
        signal,
      );
      const rows = await changes(
        raw.changes,
        type,
        signal,
        new Set(artifactIds),
      );
      const wanted = new Set(artifactIds);
      for (const row of rows) {
        if (row.type === "removeChannel" || !wanted.delete(row.artifactId))
          throw invalid();
      }
      if (wanted.size) throw invalid();
      return Object.freeze({
        startedAt: raw.startedAt as string,
        changes: rows as ArtifactCurrentPage["changes"],
      });
    },
  };
}
