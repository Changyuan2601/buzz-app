// A conversation's Claude Code session, read from the transcript Claude Code
// keeps on this computer and shown in the host's turn-transcript model. Claude
// Code owns the file; nothing here writes or keeps it.
import { readFile } from "../../buzz-mcp/app-client";
import {
  promptMessage,
  promptSections,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import type { Spawn } from "./claude";

/** The latest turns shown; the file keeps the rest. */
export const TURN_LIMIT = 50;
const STEER = "new-message-arrived-while-you-were-working";

type Json = Record<string, unknown>;
export type Conversation = Readonly<{
  sessionId: string;
  channelId: string;
  root?: string;
}>;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const blocks = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((block) => {
    const entry = object(block);
    return entry ? [entry] : [];
  });
const text = (value: unknown) =>
  typeof value === "string"
    ? value
    : blocks(value)
        .map((block) => str(block.text))
        .filter(Boolean)
        .join("\n");
const KINDS: Record<string, string> = {
  Bash: "execute",
  Read: "read",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
};

/** A Buzz prompt, or a steer wrapping one, as the turn's opening item. */
function prompt(id: string, at: number, raw: string): TranscriptItem {
  let sections = promptSections(raw);
  const steer = sections.find((section) => section.tag === STEER);
  if (steer) sections = promptSections(steer.body);
  const { text, author } = promptMessage(sections);
  return {
    id,
    at,
    type: "prompt",
    text: text || raw,
    ...(author ? { author } : {}),
    sections,
    steer: !!steer,
  };
}

/** Transcript lines as turns, each opened by a prompt. Claude Code's own
 * entries (metadata, subagents, attachments) are left out. */
export function claudeTurns(
  file: string,
  conversation: Conversation,
  working: boolean,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const tools = new Map<string, ToolItem>();
  let last = 0;
  const turn = (id: string, at: number, partial: boolean) => {
    const current = turns.at(-1);
    if (current) current.endedAt = Math.max(last, current.startedAt);
    const next: TranscriptTurn = {
      turnId: id,
      channelId: conversation.channelId,
      threadRootId: conversation.root ?? null,
      triggeringEventIds: [],
      sessionId: conversation.sessionId,
      newSession: false,
      config: [],
      startedAt: at,
      partial,
      items: [],
    };
    turns.push(next);
    return next;
  };
  for (const line of file.split("\n")) {
    let entry: Json | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    const message = object(entry.message);
    const id = str(entry.uuid);
    const at = Date.parse(str(entry.timestamp)) || last;
    if (
      !message ||
      !id ||
      (entry.type !== "user" && entry.type !== "assistant")
    )
      continue;
    const results = blocks(message.content).filter(
      (block) => block.type === "tool_result",
    );
    if (entry.type === "user" && !results.length) {
      const item = prompt(id, at, text(message.content));
      const current =
        item.type === "prompt" && item.steer ? turns.at(-1) : undefined;
      (current ?? turn(id, at, false)).items.push(item);
      last = at;
      continue;
    }
    const current = turns.at(-1) ?? turn(id, at, true);
    last = at;
    for (const result of results) {
      const tool = tools.get(str(result.tool_use_id));
      if (!tool) continue;
      tool.output = text(result.content);
      tool.status = result.is_error ? "failed" : "completed";
      tool.completedAt = at;
    }
    blocks(message.content).forEach((block, index) => {
      const key = `${id}:${index}`;
      if (block.type === "text" && str(block.text).trim())
        current.items.push({
          id: key,
          at,
          type: "message",
          text: str(block.text),
        });
      else if (block.type === "thinking" && str(block.thinking).trim())
        current.items.push({
          id: key,
          at,
          type: "thought",
          text: str(block.thinking),
        });
      else if (block.type === "tool_use") {
        const name = str(block.name);
        const input = object(block.input) ?? {};
        const path = str(input.file_path) || str(input.path);
        const tool: ToolItem = {
          id: key,
          at,
          type: "tool",
          toolCallId: str(block.id),
          title: str(input.command) || name,
          kind: KINDS[name] ?? "other",
          status: "in_progress",
          input: JSON.stringify(input, null, 2),
          output: "",
          diffs: [],
          paths: path ? [path] : [],
          truncated: false,
        };
        tools.set(tool.toolCallId, tool);
        current.items.push(tool);
      }
    });
  }
  const current = turns.at(-1);
  if (current && !working) current.endedAt = Math.max(last, current.startedAt);
  return turns;
}

/** Claude Code's project folder name for a working directory. Longer paths
 * get a hash suffix this does not reproduce, so they are not found. */
export const projectName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const PROJECT_NAME_LIMIT = 200;

/** The session's transcript, or undefined when this computer has no file for
 * it: deleted, or started in a workspace the agent no longer uses. */
export async function readTranscript(
  spawn: Spawn,
  workspace: string,
  conversation: Conversation,
  working: boolean,
  signal: AbortSignal,
): Promise<(Transcript & { more: boolean }) | undefined> {
  let directory = "";
  const process = await spawn("workspace", {
    cwd: workspace,
    onStdout: (data) => {
      directory += data;
    },
  });
  if ((await process.exited) !== 0)
    throw new Error("Could not find the agent's workspace");
  signal.throwIfAborted();
  const project = projectName(directory.trim());
  if (project.length > PROJECT_NAME_LIMIT) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await readFile(
      spawn,
      "~/.claude/projects",
      // Project names start with `-`; GNU base64 would read one as options.
      `./${project}/${conversation.sessionId}.jsonl`,
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (/no such file/i.test(error instanceof Error ? error.message : ""))
      return undefined;
    throw error;
  }
  const turns = claudeTurns(
    new TextDecoder().decode(bytes),
    conversation,
    working,
  );
  return {
    turns: turns.slice(-TURN_LIMIT),
    unknownThread: 0,
    more: turns.length > TURN_LIMIT,
  };
}
