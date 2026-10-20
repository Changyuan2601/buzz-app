// The token use of an agent's Claude Code sessions, read from the transcripts
// Claude Code keeps on this computer. Claude Code owns the files; nothing here
// writes or keeps them.
import { readFile } from "../../buzz-mcp/app-client";
import { promptSections } from "../../features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { withRevision } from "../../features/agents/session-usage";
import type { Spawn } from "./claude";
import { searchProject, workspaceProject } from "./transcript";

type Json = Record<string, unknown>;
/** Files read at once. */
const READERS = 4;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
/** A file's entries, and how many of its finished lines are not JSON. A
 * partial last line is still being written. */
function lines(file: string) {
  const all = file.split("\n");
  const entries: Json[] = [];
  let unreadable = 0;
  all.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const entry = object(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      if (index < all.length - 1) unreadable += 1;
    }
  });
  return { entries, unreadable };
}
const promptText = (content: unknown) =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .map((block) => str(object(block)?.text))
        .join("\n");

/** Where the session started in Buzz and for which agent, from its first
 * prompt's context; undefined when Buzz did not start it. */
export function buzzStart(entries: readonly Json[]) {
  const first = entries.find(
    (entry) => entry.type === "user" && !entry.isMeta && !entry.isSidechain,
  );
  const context = promptSections(
    promptText(object(first?.message)?.content),
  ).find((section) => section.tag === "context")?.body;
  const field = (name: string) =>
    context?.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim();
  const channel = field("Channel");
  if (!channel) return undefined;
  const root = field("Session scope") === "thread" && field("Thread root");
  return {
    agent: field("Agent"),
    channelId: channel.match(/\(#([^)]+)\)$/)?.[1] ?? channel,
    ...(root ? { root } : {}),
  };
}

const COUNTS = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_input_tokens",
  cacheWrite: "cache_creation_input_tokens",
} as const;

/** Each model request once: Claude Code repeats a streamed response's usage
 * on every content block's line. */
function observations(entries: readonly Json[]) {
  const seen = new Map<string, UsageObservation>();
  for (const entry of entries) {
    const message = object(entry.message);
    const usage = object(message?.usage);
    const model = str(message?.model);
    const at = Date.parse(str(entry.timestamp));
    if (entry.type !== "assistant" || !usage || !model || !at) continue;
    if (model === "<synthetic>") continue;
    const counts = {
      ...Object.fromEntries(
        Object.entries(COUNTS).map(([name, field]) => [name, usage[field]]),
      ),
      cacheWrite1h: object(usage.cache_creation)?.ephemeral_1h_input_tokens,
    };
    const requestId = str(entry.requestId) || str(message?.id);
    const key = `${str(message?.id)}:${str(entry.requestId)}`;
    seen.set(key === ":" ? `${seen.size}` : key, {
      ...(requestId ? { requestId } : {}),
      at,
      model,
      tokens: Object.fromEntries(
        Object.entries(counts).flatMap(([name, raw]) => {
          const value = count(raw);
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    });
  }
  return [...seen.values()];
}

/** The transcript names, `agent-<id>`, of the subagents the entries record
 * spawning. */
const spawned = (entries: readonly Json[]) =>
  entries.flatMap((entry) => {
    const agentId = str(object(entry.toolUseResult)?.agentId);
    return /^[\w-]+$/.test(agentId) ? [`agent-${agentId}`] : [];
  });

/** A session file's usage, with its subagents' files by name (undefined when
 * one is gone), when Buzz started it for `agent`. A subagent the session
 * recorded spawning without a file is gone too. A saved session also counts
 * when its prompt does not name an agent, as prompts did before agents were
 * named. */
export function sessionUsage(
  id: string,
  file: string,
  subagents: ReadonlyMap<string, string | undefined>,
  agent: string,
  saved: boolean,
): Omit<SessionUsage, "revision"> | undefined {
  const { entries, unreadable } = lines(file);
  const start = buzzStart(entries);
  if (!start || (start.agent ? start.agent !== agent : !saved))
    return undefined;
  const all = [...entries];
  const gaps: string[] = [];
  let skipped = unreadable;
  for (const subagent of subagents.values()) {
    if (subagent === undefined) {
      gaps.push("A subagent’s transcript is gone");
      continue;
    }
    const read = lines(subagent);
    all.push(...read.entries);
    skipped += read.unreadable;
  }
  for (const name of new Set(spawned(all)))
    if (!subagents.has(name)) gaps.push("A subagent’s transcript is gone");
  if (skipped)
    gaps.push(
      `${skipped} transcript line${skipped === 1 ? "" : "s"} unreadable`,
    );
  const times = all
    .map((entry) => Date.parse(str(entry.timestamp)))
    .filter((at) => at > 0);
  if (!times.length) return undefined;
  let title: string | undefined;
  for (const entry of entries)
    if (entry.type === "ai-title" && str(entry.aiTitle).trim())
      title = str(entry.aiTitle).trim();
  return {
    id,
    channelId: start.channelId,
    ...(start.root ? { root: start.root } : {}),
    ...(title ? { title } : {}),
    startedAt: Math.min(...times),
    lastAt: Math.max(...times),
    gaps,
    observations: observations(all),
  };
}

/** The agent's Buzz sessions in its workspace's Claude Code history, active
 * since `since`. `saved` are the session ids this app saved for it. */
export async function readUsage(
  spawn: Spawn,
  workspace: string,
  agent: string,
  saved: readonly string[],
  since: number,
  signal: AbortSignal,
): Promise<SessionUsage[]> {
  const project = await workspaceProject(spawn, workspace, signal);
  if (!project) return [];
  const [named, sidechains] = await Promise.all([
    searchProject(spawn, project, `Agent: ${agent}`, true),
    searchProject(spawn, project, '"isSidechain":true', true),
  ]);
  signal.throwIfAborted();
  const savedNames = new Set(
    saved.filter((id) => /^[\w-]+$/.test(id)).map((id) => `${id}.jsonl`),
  );
  const names = [
    ...new Set([
      ...savedNames,
      ...named.filter((name) => /^[^/]+\.jsonl$/.test(name)),
    ]),
  ];
  const subagents = new Map<string, string[]>();
  for (const path of sidechains) {
    const match = /^([\w-]+)\/subagents\/[^/]+\.jsonl$/.exec(path);
    if (match?.[1])
      subagents.set(match[1], [...(subagents.get(match[1]) ?? []), path]);
  }
  const read = async (path: string) => {
    try {
      return new TextDecoder().decode(
        // Project names start with `-`; GNU base64 would read one as options.
        await readFile(
          spawn,
          "~/.claude/projects",
          `./${project}/${path}`,
          signal,
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (/no such file/i.test(error instanceof Error ? error.message : ""))
        return undefined;
      throw error;
    }
  };
  const found: SessionUsage[] = [];
  const queue = [...names];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const file = await read(name);
      if (file === undefined) continue;
      const id = name.slice(0, -".jsonl".length);
      const files = new Map(
        await Promise.all(
          (subagents.get(id) ?? []).map(
            async (path) =>
              [
                path.slice(path.lastIndexOf("/") + 1, -".jsonl".length),
                await read(path),
              ] as const,
          ),
        ),
      );
      const session = sessionUsage(
        id,
        file,
        files,
        agent,
        savedNames.has(name),
      );
      if (session && session.lastAt >= since)
        found.push(await withRevision(session));
    }
  };
  await Promise.all(Array.from({ length: READERS }, worker));
  return found.sort((a, b) => b.lastAt - a.lastAt);
}
