import { eventDto, type RelayEvent } from "./events.ts";
import { yieldToHost } from "./yield.ts";

export const ARTIFACT_SNAPSHOT_LIMITS = Object.freeze({
  version: 1,
  maxRows: 50_000,
  pageRows: 1_000,
  pageBytes: 262_144,
  bodyRows: 100,
  bodyBytes: 8_388_608,
  lifetimeSeconds: 300,
  permanentChannelsOnly: true,
});
export type ArtifactManifestEntry = Readonly<{
  artifactId: string;
  revisionId: string;
  channelId: string;
}>;
export type ArtifactManifestPage = Readonly<{
  token: string;
  expiresAt: number;
  entries: readonly ArtifactManifestEntry[];
  nextToken: string | null;
}>;
export type ArtifactSnapshotQuery = Readonly<{
  artifact: "current";
  kinds: readonly [45010];
  [tag: `#${string}`]: readonly string[] | undefined;
}>;
export type ArtifactSnapshotRequest =
  | Readonly<{
      artifact: "snapshot";
      action: "start";
      query: ArtifactSnapshotQuery;
    }>
  | Readonly<{
      artifact: "snapshot";
      action: "page";
      token: string;
      cursor: string;
    }>
  | Readonly<{
      artifact: "snapshot";
      action: "bodies";
      token: string;
      revisionIds: readonly string[];
    }>
  | Readonly<{ artifact: "snapshot"; action: "complete"; token: string }>;
export type ArtifactSnapshotReader = {
  start(
    query: ArtifactSnapshotQuery,
    signal: AbortSignal,
  ): Promise<ArtifactManifestPage>;
  page(
    token: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<ArtifactManifestPage>;
  bodies(
    token: string,
    entries: readonly ArtifactManifestEntry[],
    signal: AbortSignal,
  ): Promise<readonly RelayEvent[]>;
  complete(token: string, signal: AbortSignal): Promise<void>;
};
export class ArtifactSnapshotError extends Error {
  constructor(
    readonly code:
      | "snapshot_reset"
      | "snapshot_limit"
      | "snapshot_invalid"
      | "snapshot_unsupported_scope",
    message: string,
  ) {
    super(message);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function artifactSnapshotFailure(value: unknown) {
  if (
    !object(value) ||
    ![
      "snapshot_reset",
      "snapshot_limit",
      "snapshot_invalid",
      "snapshot_unsupported_scope",
    ].includes(String(value.code))
  )
    return;
  return { error: "Artifact snapshot request fails", code: String(value.code) };
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const eventId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const tokenValue = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  [...value].every(
    (character) =>
      character.charCodeAt(0) > 32 && character.charCodeAt(0) < 127,
  );
const invalid = () =>
  new ArtifactSnapshotError(
    "snapshot_invalid",
    "Invalid artifact snapshot response",
  );

export function artifactSnapshotCapability(info: unknown): boolean {
  if (
    !object(info) ||
    !object(info.artifacts) ||
    !object(info.artifacts.snapshot)
  )
    return false;
  const snapshot = info.artifacts.snapshot;
  return Object.entries(ARTIFACT_SNAPSHOT_LIMITS).every(
    ([key, value]) => snapshot[key] === value,
  );
}

async function responseValue(
  response: Response,
  limit: number,
  signal: AbortSignal,
) {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      size += value.byteLength;
      if (size > limit)
        throw new ArtifactSnapshotError(
          "snapshot_limit",
          "Artifact snapshot response exceeds capacity",
        );
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const raw: unknown = JSON.parse(text);
  if (!response.ok) {
    if (
      object(raw) &&
      [
        "snapshot_reset",
        "snapshot_limit",
        "snapshot_invalid",
        "snapshot_unsupported_scope",
      ].includes(String(raw.code))
    ) {
      const code = raw.code as ArtifactSnapshotError["code"];
      throw new ArtifactSnapshotError(
        code,
        code === "snapshot_reset"
          ? "Artifact snapshot must restart"
          : code === "snapshot_limit"
            ? "Artifact snapshot exceeds capacity"
            : code === "snapshot_unsupported_scope"
              ? "Artifact snapshots require permanent channels"
              : "Invalid artifact snapshot request",
      );
    }
    throw new Error(`Artifact snapshot request fails (${response.status})`);
  }
  return raw;
}
function envelope(
  raw: unknown,
  token?: string,
): asserts raw is Record<string, unknown> {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    !tokenValue(raw.token) ||
    (token !== undefined && raw.token !== token)
  )
    throw invalid();
}
function manifest(raw: unknown, expectedToken?: string): ArtifactManifestPage {
  envelope(raw, expectedToken);
  if (
    !Number.isSafeInteger(raw.expiresAt) ||
    (raw.expiresAt as number) < 0 ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > ARTIFACT_SNAPSHOT_LIMITS.pageRows ||
    (raw.nextToken !== null && !tokenValue(raw.nextToken))
  )
    throw invalid();
  if ((raw.expiresAt as number) * 1000 <= Date.now())
    throw new ArtifactSnapshotError(
      "snapshot_reset",
      "Artifact snapshot expires",
    );
  const seen = new Set<string>();
  const entries = raw.entries.map((entry: unknown) => {
    if (
      !object(entry) ||
      !uuid(entry.artifactId) ||
      !eventId(entry.revisionId) ||
      !uuid(entry.channelId) ||
      seen.has(entry.artifactId)
    )
      throw invalid();
    seen.add(entry.artifactId);
    return Object.freeze({
      artifactId: entry.artifactId,
      revisionId: entry.revisionId,
      channelId: entry.channelId,
    });
  });
  if (raw.nextToken !== null && !entries.length) throw invalid();
  return Object.freeze({
    token: raw.token as string,
    expiresAt: raw.expiresAt as number,
    entries: Object.freeze(entries),
    nextToken: raw.nextToken as string | null,
  });
}

/** The authenticated transport owns requests. This reader admits exact signed revisions. */
export function createArtifactSnapshotReader(
  request: (
    filter: ArtifactSnapshotRequest,
    signal: AbortSignal,
  ) => Promise<Response>,
): ArtifactSnapshotReader {
  async function send(
    filter: ArtifactSnapshotRequest,
    signal: AbortSignal,
    limit: number,
  ) {
    if ("token" in filter && !tokenValue(filter.token)) throw invalid();
    return responseValue(await request(filter, signal), limit, signal);
  }
  return {
    async start(query, signal) {
      return manifest(
        await send(
          { artifact: "snapshot", action: "start", query },
          signal,
          ARTIFACT_SNAPSHOT_LIMITS.pageBytes,
        ),
      );
    },
    async page(token, cursor, signal) {
      if (!tokenValue(cursor)) throw invalid();
      return manifest(
        await send(
          { artifact: "snapshot", action: "page", token, cursor },
          signal,
          ARTIFACT_SNAPSHOT_LIMITS.pageBytes,
        ),
        token,
      );
    },
    async bodies(token, entries, signal) {
      if (
        !entries.length ||
        entries.length > ARTIFACT_SNAPSHOT_LIMITS.bodyRows ||
        entries.some(
          (entry) =>
            !uuid(entry.artifactId) ||
            !eventId(entry.revisionId) ||
            !uuid(entry.channelId),
        )
      )
        throw invalid();
      const wanted = new Map(entries.map((entry) => [entry.revisionId, entry]));
      if (wanted.size !== entries.length) throw invalid();
      const raw = await send(
        {
          artifact: "snapshot",
          action: "bodies",
          token,
          revisionIds: entries.map((entry) => entry.revisionId),
        },
        signal,
        ARTIFACT_SNAPSHOT_LIMITS.bodyBytes,
      );
      envelope(raw, token);
      if (!Array.isArray(raw.events) || raw.events.length !== entries.length)
        throw invalid();
      const events: RelayEvent[] = [];
      for (const value of raw.events) {
        signal.throwIfAborted();
        const event = eventDto(value);
        const entry = wanted.get(event.id);
        const tag = (name: string) =>
          event.tags.filter(([key]) => key === name);
        if (
          !entry ||
          event.kind !== 45010 ||
          tag("d").length !== 1 ||
          tag("d")[0]?.[1] !== entry.artifactId ||
          tag("h").length !== 1 ||
          tag("h")[0]?.[1] !== entry.channelId ||
          tag("ar").length !== 1 ||
          tag("ar")[0]?.[1] !== "1" ||
          tag("op")[0]?.[1] === "delete"
        )
          throw invalid();
        wanted.delete(event.id);
        events.push(event);
        if (events.length % 12 === 0) await yieldToHost();
      }
      signal.throwIfAborted();
      return Object.freeze(events);
    },
    async complete(token, signal) {
      const raw = await send(
        { artifact: "snapshot", action: "complete", token },
        signal,
        ARTIFACT_SNAPSHOT_LIMITS.pageBytes,
      );
      envelope(raw, token);
      if (raw.complete !== true) throw invalid();
    },
  };
}
