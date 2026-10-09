/** Portable buzz-agent-snapshot v1. No saved identity or local execution state crosses this boundary. */
import { cleanPng, pngChunks } from "../messages/image-metadata";
import { harnessKind } from "./harness-presets";
import type { AgentEdit, AgentView, ControlSnapshot } from "./control";
import { memorySlug, type MemoryEntry } from "./memory";

export const MAX_AGENT_SNAPSHOT_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_AGENT_SNAPSHOT_PNG_BYTES = 10 * 1024 * 1024;
/** Compatibility upper bound for callers without a known format; prefer the format-specific cap. */
export const MAX_AGENT_SNAPSHOT_FILE_BYTES = MAX_AGENT_SNAPSHOT_PNG_BYTES;
const snapshotFileLimit = (bytes: Uint8Array) =>
  bytes.length >= 8 &&
  bytes.subarray(0, 8).every((byte, i) => byte === MAGIC[i])
    ? MAX_AGENT_SNAPSHOT_PNG_BYTES
    : MAX_AGENT_SNAPSHOT_JSON_BYTES;
const MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const keyword = encoder.encode("buzz_agent_snapshot\0");
// NIP-44 v2 at 65,536 plaintext bytes changes to the extended length prefix;
// its base64 payload then exceeds the native reader’s 87,472-byte cap.
const MAX_MEMORY_PLAINTEXT_BYTES = 65_535;
export function restorableMemoryEntry(slug: string, body: string): boolean {
  return (
    encoder.encode(
      JSON.stringify(
        slug === "core" ? { slug, profile: body } : { slug, value: body },
      ),
    ).length <= MAX_MEMORY_PLAINTEXT_BYTES
  );
}

// The reader counts each retained DTO, including the signed event ID and
// timestamp. Reserve the longest u64 timestamp to avoid depending on the source clock.
const memoryReaderEntryBytes = (slug: string, body: string) =>
  encoder.encode(
    JSON.stringify({ slug, body, eventId: "0".repeat(64), createdAt: 0 }),
  ).length + 19;

export type MemoryLevel = "none" | "core" | "everything";
export interface AgentSnapshot {
  format: "buzz-agent-snapshot";
  version: 1;
  definition: {
    name: string;
    sourceIsBuiltin?: boolean;
    systemPrompt?: string;
    runtime?: string;
    model?: string;
    provider?: string;
    sessionPolicy?: "channel" | "thread";
    respondTo?: "owner-only" | "allowlist" | "anyone";
    respondToAllowlist?: string[];
    parallelism?: number;
    namePool?: string[];
    idleTimeoutSeconds?: number;
    maxTurnDurationSeconds?: number;
  };
  profile: {
    displayName: string;
    about?: string;
    avatarDataUrl?: string;
    avatarUrl?: string;
  };
  memory: { level: MemoryLevel; entries: { slug: string; body: string }[] };
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) =>
  typeof value === "string" &&
  encoder.encode(value).length <= max &&
  !value.includes("\0");
const invisible = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return (
    code === 0xad ||
    code === 0x34f ||
    code === 0x61c ||
    (code >= 0x115f && code <= 0x1160) ||
    (code >= 0x17b4 && code <= 0x17b5) ||
    (code >= 0x180b && code <= 0x180f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0x3164 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xfff0 && code <= 0xfff8) ||
    (code >= 0x1bca0 && code <= 0x1bca3) ||
    (code >= 0x1d173 && code <= 0x1d17a) ||
    (code >= 0xe0000 && code <= 0xe0fff)
  );
};
/** Reviewable text: permit contextual script/emoji joiners and ordinary prompt line endings. */
export function visibleSnapshotText(value: string, prompt = false): boolean {
  const chars = Array.from(value);
  const pictographic = (char: string) =>
    /^\p{Extended_Pictographic}$/u.test(char);
  for (const [i, char] of chars.entries()) {
    if (
      /[\p{Cc}]/u.test(char) &&
      !(prompt && (char === "\n" || char === "\r" || char === "\t"))
    )
      return false;
    if (!invisible(char)) continue;
    if (
      (char === "\uFE0F" || char === "\uFE0E") &&
      (/[#*0-9]/.test(chars[i - 1] ?? "") || pictographic(chars[i - 1] ?? ""))
    )
      continue;
    if (
      (char === "\u200C" || char === "\u200D") &&
      (chars[i - 1]?.codePointAt(0) ?? 0) > 127 &&
      (chars[i + 1]?.codePointAt(0) ?? 0) > 127 &&
      /[\p{Letter}\p{Mark}]/u.test(chars[i - 1] ?? "") &&
      /[\p{Letter}\p{Mark}]/u.test(chars[i + 1] ?? "")
    )
      continue;
    // Malayalam legacy chillu: consonant + virama + ZWJ at a word boundary.
    if (
      char === "\u200D" &&
      /[\u0D15-\u0D39]/u.test(chars[i - 2] ?? "") &&
      chars[i - 1] === "\u0D4D" &&
      (chars[i + 1] === undefined ||
        /\s|\p{Punctuation}/u.test(chars[i + 1] ?? ""))
    )
      continue;
    if (char === "\u200D" && pictographic(chars[i + 1] ?? "")) {
      let previous = i - 1;
      while (
        previous >= 0 &&
        (chars[previous] === "\uFE0F" ||
          chars[previous] === "\uFE0E" ||
          /[\u{1F3FB}-\u{1F3FF}]/u.test(chars[previous] ?? ""))
      )
        previous--;
      if (pictographic(chars[previous] ?? "")) continue;
    }
    return false;
  }
  return true;
}
/** Heuristic only. The export UI also discloses residual free-text risk. */
const credentialLike = (value: string) =>
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]{8,})/i.test(
    value,
  );
const optionalText = (value: unknown, max: number) =>
  value === undefined || text(value, max);
/** Native URL parsing accepts paths, queries, fragments and UTF-8 hosts but no credentials. */
const validTeamAvatarUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const keys = (record: Record<string, unknown>, allowed: string[]) =>
  Object.keys(record).every((key) => allowed.includes(key));

/** Fail closed on unknown fields: a future writer cannot smuggle credentials as "config". */
export function parseAgentSnapshot(
  bytes: Uint8Array,
  options: { teamMember?: boolean } = {},
): AgentSnapshot {
  if (
    options.teamMember &&
    bytes.length >= 8 &&
    bytes.subarray(0, 8).every((byte, i) => byte === MAGIC[i])
  )
    throw new Error(
      "Team members must be decoded from a validated team envelope.",
    );
  if (
    bytes.length >
    (options.teamMember ? 8 * 1024 * 1024 : snapshotFileLimit(bytes))
  )
    throw new Error("Snapshot exceeds the size limit.");
  const raw =
    bytes.length >= 8 &&
    bytes.subarray(0, 8).every((byte, i) => byte === MAGIC[i])
      ? pngManifest(bytes)
      : bytes;
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(raw));
  } catch {
    throw new Error("Invalid snapshot JSON.");
  }
  if (!isRecord(value)) throw new Error("Invalid snapshot JSON.");
  if (value.format !== "buzz-agent-snapshot")
    throw new Error("Unsupported snapshot format.");
  if (value.version !== 1) throw new Error("Unsupported snapshot version.");
  const {
    definition: originalDefinition,
    profile: originalProfile,
    memory: m,
  } = value;
  // Serde Option<T> accepts null as None. Normalize only known nullable fields;
  // absent and explicit null both mean inherit/default, never the string "null".
  const withoutNull = (source: unknown, optional: readonly string[]) => {
    if (!isRecord(source)) return source;
    const normalized = { ...source };
    for (const field of optional)
      if (normalized[field] === null) delete normalized[field];
    return normalized;
  };
  const d = withoutNull(originalDefinition, [
    "systemPrompt",
    "runtime",
    "model",
    "provider",
    "parallelism",
    "respondTo",
    "idleTimeoutSeconds",
    "maxTurnDurationSeconds",
  ]);
  const p = withoutNull(originalProfile, [
    "about",
    "avatarDataUrl",
    "avatarUrl",
  ]);
  if (
    !keys(value, ["format", "version", "definition", "profile", "memory"]) ||
    !isRecord(d) ||
    !isRecord(p) ||
    !isRecord(m) ||
    !keys(d, [
      "name",
      "sourceIsBuiltin",
      "systemPrompt",
      "runtime",
      "model",
      "provider",
      "parallelism",
      "sessionPolicy",
      "respondTo",
      "respondToAllowlist",
      "namePool",
      "idleTimeoutSeconds",
      "maxTurnDurationSeconds",
    ]) ||
    !keys(p, ["displayName", "about", "avatarDataUrl", "avatarUrl"]) ||
    !keys(m, ["level", "entries"]) ||
    !text(d.name, 256) ||
    !(d.name as string).trim() ||
    !text(p.displayName, 256) ||
    !(p.displayName as string).trim() ||
    (d.sourceIsBuiltin !== undefined &&
      typeof d.sourceIsBuiltin !== "boolean") ||
    !optionalText(d.systemPrompt, (options.teamMember ? 128 : 64) * 1024) ||
    (typeof d.systemPrompt === "string" &&
      !visibleSnapshotText(d.systemPrompt, true)) ||
    !visibleSnapshotText(d.name as string) ||
    !visibleSnapshotText(p.displayName as string) ||
    !optionalText(d.runtime, 128) ||
    (typeof d.runtime === "string" && !visibleSnapshotText(d.runtime)) ||
    !optionalText(d.model, 512) ||
    (typeof d.model === "string" && !visibleSnapshotText(d.model)) ||
    !optionalText(d.provider, 128) ||
    (typeof d.provider === "string" && !visibleSnapshotText(d.provider)) ||
    !["channel", "thread", undefined].includes(
      d.sessionPolicy as string | undefined,
    ) ||
    !["owner-only", "allowlist", "anyone", undefined].includes(
      d.respondTo as string | undefined,
    ) ||
    (d.respondToAllowlist !== undefined &&
      (!Array.isArray(d.respondToAllowlist) ||
        d.respondToAllowlist.length > (options.teamMember ? 2000 : 128) ||
        !d.respondToAllowlist.every((v: unknown) =>
          options.teamMember
            ? typeof v === "string" && /^[0-9a-f]{64}$/.test(v)
            : text(v, 256),
        ))) ||
    (d.namePool !== undefined &&
      (!Array.isArray(d.namePool) ||
        d.namePool.length > (options.teamMember ? 256 : 128) ||
        !d.namePool.every((v: unknown) =>
          options.teamMember
            ? text(v, 256) && !!(v as string).length
            : text(v, 256),
        ))) ||
    (d.parallelism !== undefined &&
      (!Number.isSafeInteger(d.parallelism) ||
        (d.parallelism as number) < 1 ||
        (d.parallelism as number) > 0xffffffff)) ||
    (d.idleTimeoutSeconds !== undefined &&
      (!Number.isSafeInteger(d.idleTimeoutSeconds) ||
        (d.idleTimeoutSeconds as number) < 0)) ||
    (d.maxTurnDurationSeconds !== undefined &&
      (!Number.isSafeInteger(d.maxTurnDurationSeconds) ||
        (d.maxTurnDurationSeconds as number) < 0)) ||
    !optionalText(p.about, options.teamMember ? 8 * 1024 * 1024 : 2048) ||
    (typeof p.about === "string" && !visibleSnapshotText(p.about, true)) ||
    (p.avatarDataUrl !== undefined &&
      (typeof p.avatarDataUrl !== "string" ||
        !/^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+=*$/.test(
          p.avatarDataUrl,
        ) ||
        p.avatarDataUrl.length > 2_800_000)) ||
    (p.avatarUrl !== undefined &&
      (typeof p.avatarUrl !== "string" ||
        !(options.teamMember
          ? validTeamAvatarUrl(p.avatarUrl)
          : /^https:\/\/[^\s@?#]+$/.test(p.avatarUrl)) ||
        encoder.encode(p.avatarUrl).length > 2048)) ||
    !["none", "core", "everything"].includes(m.level as string) ||
    (m.entries !== undefined && !Array.isArray(m.entries)) ||
    (Array.isArray(m.entries) &&
      (m.entries.length > (options.teamMember ? 256 : 128) ||
        !m.entries.every(
          (e) =>
            isRecord(e) &&
            keys(e, ["slug", "body"]) &&
            memorySlug(e.slug) &&
            (options.teamMember
              ? typeof e.body === "string"
              : text(e.body, 64 * 1024)) &&
            visibleSnapshotText(e.body as string, true) &&
            (options.teamMember ||
              restorableMemoryEntry(e.slug as string, e.body as string)),
        ) ||
        (m.level === "none" && m.entries.length !== 0) ||
        (m.level === "core" && m.entries.some((e) => e.slug !== "core")) ||
        new Set(m.entries.map((e) => e.slug)).size !== m.entries.length ||
        (!options.teamMember &&
          m.entries.reduce(
            (sum: number, e) => sum + memoryReaderEntryBytes(e.slug, e.body),
            0,
          ) >
            1024 * 1024) ||
        (options.teamMember
          ? m.entries.reduce(
              (sum: number, e) =>
                sum +
                encoder.encode(e.slug).length +
                encoder.encode(e.body).length,
              0,
            )
          : encoder.encode(JSON.stringify(m.entries)).length) >
          1024 * 1024))
  )
    throw new Error("Invalid snapshot manifest.");
  return {
    ...value,
    definition: d,
    profile: p,
    memory: { ...m, entries: m.entries ?? [] },
  } as AgentSnapshot;
}

/** The conversation context an agent runs with: its own choice, else the
 * agent defaults it inherits. Null while those defaults are unknown. */
export function effectiveSessionPolicy(
  agent: Pick<AgentView, "sessionPolicy">,
  defaultSessionPolicy?: "channel" | "thread",
): "channel" | "thread" | null {
  return agent.sessionPolicy ?? defaultSessionPolicy ?? null;
}

/** Explicit allowlist. In particular args, workspace, environment, imported blobs, and identity are absent. */
export function buildAgentSnapshot(
  agent: AgentView,
  level: MemoryLevel = "none",
  memories: readonly Pick<MemoryEntry, "slug" | "body">[] = [],
  defaultSessionPolicy?: "channel" | "thread",
): AgentSnapshot {
  const sessionPolicy = effectiveSessionPolicy(agent, defaultSessionPolicy);
  if (
    agent.harness.command !== "buzz-agent" ||
    agent.respondTo !== "owner-only" ||
    agent.launchModelEnv ||
    agent.launchProviderEnv ||
    agent.backend ||
    agent.harness.databricks ||
    agent.harness.environmentKeys.some((key) => key !== "BUZZ_ACP_AGENTS") ||
    (agent.harness.environmentKeys.includes("BUZZ_ACP_AGENTS") &&
      agent.launchParallelism == null) ||
    (agent.launchParallelism != null &&
      (!Number.isInteger(agent.launchParallelism) ||
        agent.launchParallelism < 1 ||
        agent.launchParallelism > 32)) ||
    sessionPolicy === null
  ) {
    throw new Error(
      "This agent has runtime, response, or environment settings that cannot be exported faithfully.",
    );
  }
  // Only signed, fixed native reason names may enter a user-facing error.
  const limitations = agent.snapshotExportLimitations;
  if (!Array.isArray(limitations))
    throw new Error("This agent cannot be exported faithfully on this host.");
  if (limitations.length) {
    const names = [
      "team instructions",
      "idle timeout",
      "turn timeout",
      "effort level",
      "behavioral environment overrides",
    ];
    if (
      limitations.some(
        (name) => typeof name !== "string" || !names.includes(name),
      )
    )
      throw new Error("This agent cannot be exported faithfully.");
    throw new Error(
      `This agent cannot be exported faithfully because of: ${limitations.join(", ")}. ${limitations.includes("effort level") ? "Check Agent defaults for inherited effort and remove it before exporting." : "Remove the listed settings before exporting."}`,
    );
  }
  for (const value of [
    agent.name,
    agent.systemPrompt,
    agent.launchModel ?? "",
    agent.launchProvider ?? "",
    agent.picture ?? "",
  ]) {
    if (credentialLike(value))
      throw new Error(
        "Portable configuration appears to contain a credential. Remove it before export.",
      );
  }
  const entries =
    level === "none"
      ? []
      : memories
          .filter((entry) => level === "everything" || entry.slug === "core")
          .map(({ slug, body }) => ({ slug, body }));
  const snapshot: AgentSnapshot = {
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      ...(agent.launchModel ? { model: agent.launchModel } : {}),
      ...(agent.launchProvider ? { provider: agent.launchProvider } : {}),
      ...(agent.launchParallelism != null
        ? { parallelism: agent.launchParallelism }
        : {}),
      runtime: "buzz-agent",
      respondTo: "owner-only",
      sessionPolicy,
    },
    profile: {
      displayName: agent.name,
      ...(agent.picture && /^https:\/\/[^\s@?#]+$/.test(agent.picture)
        ? { avatarUrl: agent.picture }
        : {}),
    },
    memory: { level, entries },
  };
  parseAgentSnapshot(encoder.encode(JSON.stringify(snapshot)));
  return snapshot;
}

export type SnapshotImportOptions = Pick<
  ControlSnapshot,
  "defaultWorkspace" | "harnessOptions"
> & {
  /** Catalog-only portable transport. Never use a publisher's executable path. */
  transportAlias?: string;
  /** Team creation persists definition-only settings in native imported.record. */
  teamMember?: boolean;
};

/** The portable definition is the only authority for both standalone and team creation.
 * Absent session policy means channel (reference v1 behavior); absent worker count
 * leaves the destination default untouched. Explicit counts override that default.
 * Explicit empty selectors clear inherited model/provider values. Native selection
 * comes exclusively from available local options, not a publisher command.
 */
export function snapshotImportEdit(
  snapshot: AgentSnapshot,
  options: SnapshotImportOptions,
): AgentEdit {
  if (options.transportAlias && options.transportAlias !== "buzz-acp")
    throw new Error(
      `Import is blocked: unsupported ACP transport ${options.transportAlias}.`,
    );
  const limitations = snapshotLimitations(
    snapshot,
    options.teamMember ?? false,
  );
  if (limitations.length)
    throw new Error(`Import is blocked: ${limitations.join("; ")}.`);
  const runtime = snapshot.definition.runtime ?? "buzz-agent";
  const selected = options.harnessOptions?.find(
    (option) =>
      option.available !== false && harnessKind(option.command) === runtime,
  );
  if (!selected)
    throw new Error(`${runtime} is unavailable. Install it in Settings first.`);
  const model = snapshot.definition.model ?? "";
  const provider = snapshot.definition.provider ?? "";
  // The native integration owns selector semantics. An external harness cannot
  // receive provider overrides through AgentEdit; Pi requires a model with one.
  const policy = selected.configurationPolicy;
  if (
    (policy?.provider === "external" ||
      (!policy && ["claude", "hermes"].includes(runtime))) &&
    provider
  )
    throw new Error("Import is blocked: external harness provider selector.");
  if (
    (policy?.model === "withProvider" || (!policy && runtime === "pi")) &&
    provider &&
    !model
  )
    throw new Error("Import is blocked: Pi provider requires a model.");
  return {
    name: snapshot.profile.displayName,
    systemPrompt: snapshot.definition.systemPrompt ?? "",
    sessionPolicy: snapshot.definition.sessionPolicy ?? "channel",
    workspace: options.defaultWorkspace ?? "",
    harness: {
      command: selected.command,
      args: selected.defaultArgs ?? [],
      model,
      provider,
      databricks: null,
    },
    environment:
      options.teamMember || snapshot.definition.parallelism === undefined
        ? {}
        : { BUZZ_ACP_AGENTS: String(snapshot.definition.parallelism) },
    ...(options.teamMember && snapshot.profile.avatarDataUrl
      ? { picture: snapshot.profile.avatarDataUrl }
      : snapshot.profile.avatarUrl
        ? { picture: snapshot.profile.avatarUrl }
        : {}),
  };
}

/** A valid v1 manifest can describe settings that native AgentEdit cannot persist. */
export function snapshotLimitations(
  snapshot: AgentSnapshot,
  teamMember = false,
): string[] {
  const d = snapshot.definition;
  return [
    ...(d.name !== snapshot.profile.displayName
      ? ["definition and profile names disagree"]
      : []),
    ...(d.runtime !== undefined &&
    !["buzz-agent", "goose", "pi", "claude", "hermes"].includes(d.runtime)
      ? ["runtime (unsupported)"]
      : []),
    ...(!teamMember && d.respondTo && d.respondTo !== "owner-only"
      ? ["response policy"]
      : []),
    ...(!teamMember && d.respondToAllowlist?.length
      ? ["source response allowlist"]
      : []),
    // Native listener workers accept 1..=32; a larger reference request cannot
    // be silently clamped without changing the agent's behavior.
    ...(d.parallelism !== undefined && d.parallelism > 32
      ? ["parallelism (native supports 1–32 workers)"]
      : []),
    ...(!teamMember && d.namePool?.length ? ["name pool"] : []),
    ...(!teamMember && d.idleTimeoutSeconds !== undefined
      ? ["idle timeout"]
      : []),
    ...(!teamMember && d.maxTurnDurationSeconds !== undefined
      ? ["turn timeout"]
      : []),
    ...(!teamMember && snapshot.profile.about ? ["profile about"] : []),
  ];
}

function u32(bytes: Uint8Array, at: number) {
  return (
    ((bytes[at] ?? 0) * 0x1000000 +
      ((bytes[at + 1] ?? 0) << 16) +
      ((bytes[at + 2] ?? 0) << 8) +
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}
function put32(bytes: Uint8Array, at: number, value: number) {
  bytes[at] = value >>> 24;
  bytes[at + 1] = value >>> 16;
  bytes[at + 2] = value >>> 8;
  bytes[at + 3] = value;
}
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const result = new Uint8Array(data.length + 12);
  put32(result, 0, data.length);
  result.set(encoder.encode(type), 4);
  result.set(data, 8);
  put32(result, 8 + data.length, crc(result.subarray(4, 8 + data.length)));
  return result;
}
const concat = (parts: Uint8Array[]) => {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
/** RFC 2083 tEXt chunk: base64 JSON, same keyword/encoding as block/buzz. */
export function encodeAgentSnapshot(
  snapshot: AgentSnapshot,
  format: "json" | "png",
  artwork?: Uint8Array,
) {
  const { entries, ...memory } = snapshot.memory;
  const manifest = encoder.encode(
    JSON.stringify(
      {
        ...snapshot,
        memory: entries.length ? snapshot.memory : memory,
      },
      null,
      2,
    ),
  );
  parseAgentSnapshot(manifest);
  if (format === "json") return manifest;
  const ihdr = new Uint8Array(13);
  put32(ihdr, 0, 1);
  put32(ihdr, 4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // Zlib stored block containing filter 0 and transparent RGBA; Adler-32 = 0x00050001.
  const pixel = new Uint8Array([
    0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0, 0, 0, 0, 0, 0x00, 0x05, 0x00,
    0x01,
  ]);
  const base64 = btoa(
    Array.from(manifest, (byte) => String.fromCharCode(byte)).join(""),
  );
  let imageParts: Uint8Array[] = [
    chunk("IHDR", ihdr),
    chunk("IDAT", pixel),
    chunk("IEND", new Uint8Array()),
  ];
  if (artwork) {
    // Artwork comes from a canvas-produced PNG. Never copy its ancillary metadata.
    const parts: Uint8Array[] = [];
    let at = 8;
    if (
      artwork.length > MAX_AGENT_SNAPSHOT_PNG_BYTES ||
      !artwork.subarray(0, 8).every((v, i) => v === MAGIC[i])
    )
      throw new Error("Invalid snapshot artwork.");
    while (at + 12 <= artwork.length) {
      const length = u32(artwork, at);
      if (at + length + 12 > artwork.length)
        throw new Error("Invalid snapshot artwork.");
      const type = decoder.decode(artwork.subarray(at + 4, at + 8));
      if (
        u32(artwork, at + 8 + length) !==
        crc(artwork.subarray(at + 4, at + 8 + length))
      )
        throw new Error("Invalid snapshot artwork.");
      if (["IHDR", "IDAT", "IEND"].includes(type))
        parts.push(artwork.slice(at, at + length + 12));
      at += length + 12;
      if (type === "IEND") break;
    }
    if (
      at !== artwork.length ||
      parts.length < 3 ||
      decoder.decode(parts[0]?.subarray(4, 8)) !== "IHDR" ||
      decoder.decode(parts.at(-1)?.subarray(4, 8)) !== "IEND"
    )
      throw new Error("Invalid snapshot artwork.");
    imageParts = parts;
  }
  const png = concat([
    MAGIC,
    imageParts[0] ?? chunk("IHDR", ihdr),
    chunk("tEXt", concat([keyword, encoder.encode(base64)])),
    ...imageParts.slice(1),
  ]);
  if (png.length > MAX_AGENT_SNAPSHOT_PNG_BYTES)
    throw new Error("Snapshot exceeds the size limit.");
  parseAgentSnapshot(png);
  return png;
}
/** A 1x1 RGBA scanline is five bytes, regardless of compression or PNG filter. */
async function transparentSinglePixel(idat: Uint8Array[]): Promise<boolean> {
  const stream = new ReadableStream<BufferSource>({
    start(controller) {
      for (const part of idat) controller.enqueue(Uint8Array.from(part));
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const scanline = new Uint8Array(5);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.length > scanline.length) {
        await reader.cancel();
        throw new Error("Invalid snapshot artwork.");
      }
      scanline.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== 5 || (scanline[0] ?? 255) > 4)
    throw new Error("Invalid snapshot artwork.");
  // With one pixel there are no left/up samples; every PNG filter leaves alpha unchanged.
  return scanline[4] === 0;
}

/** Validate first, then let the existing avatar sanitizer own metadata and animation. */
export async function snapshotPngArtwork(
  bytes: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 8).every((byte, i) => byte === MAGIC[i])
  )
    return undefined;
  // The caller parses the manifest first; keep this utility safe when used alone.
  parseAgentSnapshot(bytes);
  const chunks = pngChunks(bytes);
  const animated = chunks.some(({ kind }) => kind === "acTL");
  // Check animated appearance before handing the original container to upload;
  // still PNGs with ICC/orientation must be redrawn there, not pre-stripped.
  cleanPng(bytes, undefined, animated);
  const header = chunks[0]?.payload;
  const singleRgba =
    !animated &&
    header?.length === 13 &&
    u32(header, 0) === 1 &&
    u32(header, 4) === 1 &&
    header[8] === 8 &&
    header[9] === 6 &&
    header[12] === 0;
  if (singleRgba) {
    const idat = chunks
      .filter(({ kind }) => kind === "IDAT")
      .map(({ payload }) => payload);
    if (await transparentSinglePixel(idat)) return undefined;
  }
  return bytes;
}

function pngManifest(bytes: Uint8Array) {
  let offset = 8,
    found: Uint8Array | undefined,
    image = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    if (
      length > MAX_AGENT_SNAPSHOT_PNG_BYTES ||
      offset + 12 + length > bytes.length
    )
      throw new Error("Invalid PNG snapshot.");
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      u32(bytes, offset + 8 + length) !==
      crc(bytes.subarray(offset + 4, offset + 8 + length))
    )
      throw new Error("Invalid PNG snapshot.");
    if (
      offset === 8 &&
      (type !== "IHDR" ||
        length !== 13 ||
        !u32(payload, 0) ||
        !u32(payload, 4) ||
        u32(payload, 0) > 2048 ||
        u32(payload, 4) > 2048)
    )
      throw new Error("Invalid PNG snapshot.");
    if (type === "IDAT") image = true;
    if (
      type === "tEXt" &&
      payload.length >= keyword.length &&
      payload.subarray(0, keyword.length).every((b, i) => b === keyword[i]) &&
      payload[keyword.length - 1] === 0
    ) {
      if (found) throw new Error("Invalid PNG snapshot.");
      const encoded = decoder.decode(payload.subarray(keyword.length));
      if (!/^[a-zA-Z0-9+/]+=*$/.test(encoded))
        throw new Error("Invalid PNG snapshot.");
      try {
        found = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      } catch {
        throw new Error("Invalid PNG snapshot.");
      }
    }
    offset += length + 12;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!image || !ended || offset !== bytes.length || !found)
    throw new Error("PNG does not contain a buzz_agent_snapshot tEXt chunk.");
  return found;
}
