import { avatarSource } from "../../shared/avatar-source.ts";
import type { RelayEvent } from "../relay/events.ts";
import type { AgentView } from "./control.ts";
import { harnessKind } from "./harness-presets.ts";
import { effectiveSessionPolicy } from "./snapshot.ts";
import {
  AGENT_CATALOG_KIND,
  type Body,
  bytes,
  MAX_CONTENT_BYTES,
  object,
  TEAM_CATALOG_KIND,
} from "./catalog-envelope.ts";

export {
  AGENT_CATALOG_KIND,
  TEAM_CATALOG_KIND,
  validCatalogEnvelope,
} from "./catalog-envelope.ts";

/** Team-catalog projection version and NIP-AP size limits. */
export const TEAM_CATALOG_VERSION = 1;
const SHARED_TAG = ["shared", "true"] as const;
const MAX_DISPLAY_NAME_CHARS = 128;
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 280;
const MAX_TEAM_MEMBERS = 64;
const MAX_TEAM_NAME_BYTES = 256;
const MAX_TEAM_TEXT_BYTES = 4 * 1024;
const MAX_MEMBER_PROMPT_BYTES = 16 * 1024;
const MAX_MEMBER_KEY_BYTES = 128;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_HTTP_AVATAR_BYTES = 2048;
const STOCK_ACP = "buzz-acp";

export type SessionPolicy = "channel" | "thread";
export type RespondTo = "anyone" | "owner-only";

/** The adoptable fields of one shared agent; all other content is ignored. */
export interface CatalogAgent {
  displayName: string;
  systemPrompt: string;
  description?: string;
  avatarUrl?: string;
  runtime?: string;
  model?: string;
  provider?: string;
  /** Portable ACP transport alias; never a local path. */
  acpCommand?: string;
  respondTo?: RespondTo;
  sessionPolicy: SessionPolicy;
}
export interface CatalogTeamMember extends CatalogAgent {
  memberKey: string;
}
export interface AgentPublication {
  kind: typeof AGENT_CATALOG_KIND;
  eventId: string;
  owner: string;
  d: string;
  createdAt: number;
  agent: CatalogAgent;
}
export interface TeamPublication {
  kind: typeof TEAM_CATALOG_KIND;
  eventId: string;
  owner: string;
  d: string;
  createdAt: number;
  name: string;
  description?: string;
  instructions?: string;
  members: CatalogTeamMember[];
}
export type CatalogPublication = AgentPublication | TeamPublication;

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI = /\p{Emoji}/u;
const CONTROL = /\p{Cc}/u;

/** NIP-AP visible-text policy: reject concealed, bidi and control characters.
 * Emoji ZWJ sequences and VS16 after an emoji base remain legal. */
export function visibleText(value: string, multiline: boolean): boolean {
  const chars = [...value];
  return chars.every((char, index) => {
    if (multiline && (char === "\n" || char === "\t")) return true;
    if (CONTROL.test(char)) return false;
    if (!DEFAULT_IGNORABLE.test(char)) return true;
    const previous = chars[index - 1] ?? "";
    if (char === "\uFE0F") return EMOJI.test(previous);
    if (char === "\u200D")
      return (
        (PICTOGRAPHIC.test(previous) || previous === "\uFE0F") &&
        PICTOGRAPHIC.test(chars[index + 1] ?? "")
      );
    return false;
  });
}

export function portableAcpCommand(command: string): boolean {
  return (
    command === STOCK_ACP ||
    (command.length <= 255 && /^buzz-[A-Za-z0-9_-]+-acp$/.test(command))
  );
}

/** The first non-stock ACP transport alias a publication names. This app
 * launches only the bundled transport, so such an entry can't be adopted
 * faithfully; callers refuse it rather than substituting silently. */
export function unsupportedTransport(
  publication: AgentPublication | TeamPublication,
): string | undefined {
  const agents =
    publication.kind === AGENT_CATALOG_KIND
      ? [publication.agent]
      : publication.members;
  return agents.find(
    (agent) => agent.acpCommand && agent.acpCommand !== STOCK_ACP,
  )?.acpCommand;
}
export const unsupportedTransportMessage = (name: string, alias: string) =>
  `${name} uses the ${alias} transport, which this app can't run yet, so it can't be added.`;

/** Only HTTPS artwork travels; inline art would exceed the outbox budget and
 * the reader still renders through the authenticated media path. */
function catalogAvatar(value: unknown): string | undefined {
  const source = avatarSource(value);
  return source?.startsWith("https:") && bytes(source) <= MAX_HTTP_AVATAR_BYTES
    ? source
    : undefined;
}

export function catalogSlug(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Invalid agent identity");
  return pubkey;
}

/** Opaque per-team member identity; discloses no local identifier. */
export async function memberKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`buzz:team-catalog:member-key:v1\0${id}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Field order is the wire order; keys absent here can never leak. An agent
 * that inherits its conversation context shares the defaults it runs with,
 * as snapshot export does. */
function persona(agent: AgentView, defaultSessionPolicy?: SessionPolicy) {
  const sessionPolicy = effectiveSessionPolicy(agent, defaultSessionPolicy);
  if (!sessionPolicy)
    throw new Error(
      `Agent defaults for '${agent.name}' are unavailable. Refresh agents and try again.`,
    );
  // The bundled transport is a local path; only its portable alias travels.
  const acp =
    agent.acpCommand
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.exe$/i, "") ?? STOCK_ACP;
  const runtime =
    agent.harness.command
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.toLowerCase() === "buzz-agent.exe"
      ? "buzz-agent"
      : harnessKind(agent.harness.command);
  if (!runtime)
    throw new Error(
      `Agent '${agent.name}' uses a runtime that cannot be shared with the community catalog.`,
    );
  const avatar = catalogAvatar(agent.picture);
  const model = agent.harness.model.trim();
  const provider = agent.harness.provider.trim();
  return {
    display_name: agent.name,
    system_prompt: agent.systemPrompt,
    ...(portableAcpCommand(acp) ? { acp_command: acp } : {}),
    ...(avatar ? { avatar_url: avatar } : {}),
    runtime,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    // An allowlist would disclose the owner's trusted pubkeys; downgrade it.
    ...(agent.respondTo
      ? {
          respond_to:
            agent.respondTo === "allowlist" ? "owner-only" : agent.respondTo,
        }
      : {}),
    session_policy: sessionPolicy,
  };
}

function checkDefinition(name: string, prompt: string, label = "Agent") {
  if (!name.trim()) throw new Error("Display name is required");
  if ([...name].length > MAX_DISPLAY_NAME_CHARS)
    throw new Error(
      `Display name is too long (${[...name].length} characters, max ${MAX_DISPLAY_NAME_CHARS})`,
    );
  if (bytes(prompt) > MAX_SYSTEM_PROMPT_BYTES)
    throw new Error(
      `${label} instructions are too long (${bytes(prompt)} bytes, max ${MAX_SYSTEM_PROMPT_BYTES})`,
    );
  if (!visibleText(name, false) || !visibleText(prompt, true))
    throw new Error(
      `${label} contains prohibited invisible or formatting characters`,
    );
}

export function agentCatalogContent(
  agent: AgentView,
  defaultSessionPolicy?: SessionPolicy,
): string {
  checkDefinition(agent.name, agent.systemPrompt);
  const content = JSON.stringify(persona(agent, defaultSessionPolicy));
  if (bytes(content) > MAX_CONTENT_BYTES)
    throw new Error("Agent definition is too large to share");
  return content;
}

export interface CatalogTeamSource {
  id: string;
  name: string;
  agents: readonly string[];
  /** From the team's saved portable definition, when it has one. */
  description?: string | null | undefined;
  instructions?: string | null | undefined;
}

export async function teamCatalogContent(
  team: CatalogTeamSource,
  members: readonly AgentView[],
  defaultSessionPolicy?: SessionPolicy,
): Promise<string> {
  const fail = (reason: string) => {
    throw new Error(reason);
  };
  if (!team.name.trim())
    fail("invalid team projection: the team name is empty");
  if (bytes(team.name) > MAX_TEAM_NAME_BYTES)
    fail(
      `team too large to share: the team name is ${bytes(team.name)} bytes (limit ${MAX_TEAM_NAME_BYTES})`,
    );
  if (!visibleText(team.name, false))
    fail(
      "the team name contains prohibited invisible or formatting characters",
    );
  if (team.agents.length > MAX_TEAM_MEMBERS)
    fail(
      `team too large to share: ${team.agents.length} members (limit ${MAX_TEAM_MEMBERS})`,
    );
  const text: Record<string, string> = {};
  for (const [field, value, max] of [
    ["description", team.description, MAX_TEAM_TEXT_BYTES],
    ["instructions", team.instructions, MAX_MEMBER_PROMPT_BYTES],
  ] as const) {
    const shown = optionalText(value);
    if (!shown) continue;
    if (bytes(shown) > max)
      fail(
        `team too large to share: the team ${field} is ${bytes(shown)} bytes (limit ${max})`,
      );
    if (!visibleText(shown, true))
      fail(
        `the team ${field} contains prohibited invisible or formatting characters`,
      );
    text[field] = shown;
  }
  const projected = [];
  for (const pubkey of team.agents) {
    const agent = members.find((member) => member.pubkey === pubkey);
    if (!agent) throw new Error(`team member ${pubkey} not found`);
    checkDefinition(agent.name, agent.systemPrompt);
    if (bytes(agent.systemPrompt) > MAX_MEMBER_PROMPT_BYTES)
      fail(
        `team too large to share: the system prompt for '${agent.name}' is ${bytes(agent.systemPrompt)} bytes (limit ${MAX_MEMBER_PROMPT_BYTES})`,
      );
    const { session_policy, ...fields } = persona(agent, defaultSessionPolicy);
    projected.push({
      member_key: await memberKey(pubkey),
      ...fields,
      // The team schema omits the default boundary.
      ...(session_policy === "thread" ? { session_policy } : {}),
    });
  }
  const content = JSON.stringify({
    v: TEAM_CATALOG_VERSION,
    name: team.name,
    ...text,
    members: projected,
  });
  if (bytes(content) > MAX_CONTENT_BYTES) fail("team too large to share");
  return content;
}

/** The exact owner-to-self envelope the native signer admits. */
export function catalogTemplate(
  kind: typeof AGENT_CATALOG_KIND | typeof TEAM_CATALOG_KIND,
  d: string,
  content: string,
  shared: boolean,
) {
  return {
    kind,
    content,
    tags: [["d", d], ...(shared ? [[...SHARED_TAG]] : [])],
  };
}

const single = (event: RelayEvent, name: string) => {
  const values = event.tags.filter((tag) => tag[0] === name);
  return values.length === 1 ? values[0] : undefined;
};
export function catalogD(event: RelayEvent): string | undefined {
  const tag = single(event, "d");
  return tag && tag.length >= 2 && tag[1] ? tag[1] : undefined;
}
export function isShared(event: RelayEvent): boolean {
  const [tag, ...extra] = event.tags.filter((tag) => tag[0] === "shared");
  return !!tag && !extra.length && tag.length === 2 && tag[1] === SHARED_TAG[1];
}

/** NIP-33: newest created_at, then lowest id, per (kind, owner, d). The head
 * is claimed before visibility so an unshared head hides older shared ones. */
export function catalogHeads(events: readonly RelayEvent[]) {
  const heads = new Map<string, RelayEvent>();
  for (const event of [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1),
  )) {
    if (event.kind !== AGENT_CATALOG_KIND && event.kind !== TEAM_CATALOG_KIND)
      continue;
    const d = catalogD(event);
    if (d === undefined) continue;
    const key = `${event.kind}:${event.pubkey}:${d}`;
    if (!heads.has(key)) heads.set(key, event);
  }
  return heads;
}

const optionalText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

function parseAgent(
  body: Body,
  memberPrompt = false,
): CatalogAgent | undefined {
  const name = body.display_name;
  const prompt = body.system_prompt ?? "";
  if (typeof name !== "string" || typeof prompt !== "string") return;
  try {
    checkDefinition(name, prompt);
  } catch {
    return;
  }
  if (memberPrompt && bytes(prompt) > MAX_MEMBER_PROMPT_BYTES) return;
  const description = body.description ?? undefined;
  if (
    description !== undefined &&
    (typeof description !== "string" ||
      [...description].length > MAX_DESCRIPTION_CHARS ||
      !visibleText(description, true))
  )
    return;
  const acp = body.acp_command ?? undefined;
  if (
    acp !== undefined &&
    (typeof acp !== "string" || !portableAcpCommand(acp))
  )
    return;
  const identifiers: Partial<Record<"runtime" | "model" | "provider", string>> =
    {};
  for (const key of ["runtime", "model", "provider"] as const) {
    const value = optionalText(body[key]);
    if (
      value &&
      (bytes(value) > MAX_IDENTIFIER_BYTES || !visibleText(value, false))
    )
      return;
    if (value) identifiers[key] = value;
  }
  const respondTo =
    body.respond_to === "allowlist" || body.respond_to === "owner-only"
      ? "owner-only"
      : body.respond_to === "anyone"
        ? "anyone"
        : undefined;
  const avatarUrl = catalogAvatar(body.avatar_url);
  const shownDescription = optionalText(description);
  return {
    displayName: name,
    systemPrompt: prompt,
    ...(shownDescription ? { description: shownDescription } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...identifiers,
    ...(acp ? { acpCommand: acp } : {}),
    ...(respondTo ? { respondTo } : {}),
    sessionPolicy: body.session_policy === "thread" ? "thread" : "channel",
  };
}

/** Untrusted boundary: any invalid field rejects the whole publication. */
export function parsePublication(
  event: RelayEvent,
): CatalogPublication | undefined {
  const d = catalogD(event);
  const body = object(event.content);
  if (!d || !body || !isShared(event)) return;
  const base = {
    eventId: event.id,
    owner: event.pubkey,
    d,
    createdAt: event.created_at,
  };
  if (event.kind === AGENT_CATALOG_KIND) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(d)) return;
    const agent = parseAgent(body);
    return agent && { kind: AGENT_CATALOG_KIND, ...base, agent };
  }
  if (
    event.kind !== TEAM_CATALOG_KIND ||
    [...d].length > 64 ||
    /[\s\p{Cc}]/u.test(d)
  )
    return;
  if (body.v !== TEAM_CATALOG_VERSION) return;
  const { name, description, instructions, members } = body;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    bytes(name) > MAX_TEAM_NAME_BYTES ||
    !visibleText(name, false) ||
    !Array.isArray(members) ||
    members.length > MAX_TEAM_MEMBERS
  )
    return;
  for (const [value, max] of [
    [description, MAX_TEAM_TEXT_BYTES],
    [instructions, MAX_MEMBER_PROMPT_BYTES],
  ] as const)
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" ||
        bytes(value) > max ||
        !visibleText(value, true))
    )
      return;
  const keys = new Set<string>();
  const parsed: CatalogTeamMember[] = [];
  for (const raw of members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const member = raw as Body;
    const key = member.member_key;
    if (
      typeof key !== "string" ||
      !key.trim() ||
      bytes(key) > MAX_MEMBER_KEY_BYTES ||
      keys.has(key)
    )
      return;
    keys.add(key);
    const agent = parseAgent(member, true);
    if (!agent) return;
    parsed.push({ ...agent, memberKey: key });
  }
  const shownDescription = optionalText(description);
  const shownInstructions = optionalText(instructions);
  return {
    kind: TEAM_CATALOG_KIND,
    ...base,
    name,
    ...(shownDescription ? { description: shownDescription } : {}),
    ...(shownInstructions ? { instructions: shownInstructions } : {}),
    members: parsed,
  };
}

/** The v1 team snapshot shape accepted by the shared team import path. Catalog
 * entries never carry memories, allowlists or secrets, so neither does this. */
export interface CatalogTeamSnapshot {
  format: "buzz-team-snapshot";
  version: 1;
  team: { name: string; description?: string; instructions?: string };
  members: {
    format: "buzz-agent-snapshot";
    version: 1;
    definition: {
      name: string;
      systemPrompt: string;
      runtime?: string;
      model?: string;
      provider?: string;
      sessionPolicy: SessionPolicy;
      respondTo?: RespondTo;
    };
    profile: { displayName: string; about?: string; avatarUrl?: string };
    memory: { level: "none"; entries: [] };
  }[];
}

/** Adapts a parsed catalog team for import. The importer still validates the
 * result natively before creating anything. */
export function catalogTeamSnapshot(
  publication: TeamPublication,
): CatalogTeamSnapshot {
  const optional = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
  return {
    format: "buzz-team-snapshot",
    version: 1,
    team: {
      name: publication.name,
      ...optional("description", publication.description),
      ...optional("instructions", publication.instructions),
    },
    members: publication.members.map((member) => ({
      format: "buzz-agent-snapshot",
      version: 1,
      definition: {
        name: member.displayName,
        systemPrompt: member.systemPrompt,
        ...optional("runtime", member.runtime),
        ...optional("model", member.model),
        ...optional("provider", member.provider),
        sessionPolicy: member.sessionPolicy,
        ...optional("respondTo", member.respondTo),
      },
      profile: {
        displayName: member.displayName,
        ...optional("about", member.description),
        ...optional("avatarUrl", member.avatarUrl),
      },
      memory: { level: "none", entries: [] },
    })),
  };
}
