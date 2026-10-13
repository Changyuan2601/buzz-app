// A conversation's Codex thread, read back through app-server and shown in the
// host's turn-transcript model. Codex owns the history; nothing here is saved.
import {
  promptSections,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import { AppServer, type Spawn } from "./rpc";

/** The latest turns shown; earlier ones stay in Codex's own history. */
export const TURN_LIMIT = 20;

type Json = Record<string, unknown>;
type Turn = {
  id: string;
  items: Json[];
  status: string;
  error: { message?: string } | null;
  startedAt: number | null;
  completedAt: number | null;
};
export type CodexTranscript = Transcript & { more: boolean; working: boolean };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const display = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
const STATUS: Record<string, string> = {
  inProgress: "in_progress",
  failed: "failed",
  declined: "failed",
};

/** The owner's request inside a Buzz turn input; other framing stays in sections. */
function request(text: string) {
  const quoted = [...text.matchAll(/^Request: (".*")$/gm)].pop()?.[1];
  try {
    return quoted ? String(JSON.parse(quoted)) : text;
  } catch {
    return text;
  }
}

function item(
  value: Json,
  at: number,
  steer: boolean,
): TranscriptItem | undefined {
  const id = str(value.id);
  const tool = (patch: Partial<ToolItem>): ToolItem => ({
    id,
    at,
    type: "tool",
    toolCallId: id,
    title: "",
    kind: "other",
    status: STATUS[str(value.status)] ?? "completed",
    input: "",
    output: "",
    diffs: [],
    paths: [],
    truncated: false,
    ...(typeof value.durationMs === "number"
      ? { completedAt: at + value.durationMs }
      : {}),
    ...patch,
  });
  switch (value.type) {
    case "userMessage": {
      const raw = (Array.isArray(value.content) ? value.content : [])
        .map((part: Json) => str(part.text))
        .join("\n");
      return {
        id,
        at,
        type: "prompt",
        text: request(raw),
        sections: promptSections(raw),
        steer,
      };
    }
    case "agentMessage":
      return { id, at, type: "message", text: str(value.text) };
    case "reasoning": {
      const text = (Array.isArray(value.summary) ? value.summary : []).join(
        "\n\n",
      );
      return text ? { id, at, type: "thought", text } : undefined;
    }
    case "plan":
      return { id, at, type: "status", text: str(value.text) };
    case "commandExecution":
      return tool({
        title: str(value.command),
        kind: "execute",
        output: str(value.aggregatedOutput),
      });
    case "fileChange": {
      const changes = (
        Array.isArray(value.changes) ? value.changes : []
      ) as Json[];
      return tool({
        title: "Edit files",
        kind: "edit",
        paths: changes.map((change) => str(change.path)),
        output: changes.map((change) => str(change.diff)).join("\n"),
      });
    }
    case "mcpToolCall":
      return tool({
        title: `${str(value.server)}.${str(value.tool)}`,
        input: display(value.arguments),
        output: display(value.error ?? value.result),
      });
    case "dynamicToolCall":
      return tool({
        title: [value.namespace, value.tool].filter(Boolean).join("."),
        input: display(value.arguments),
        output: (Array.isArray(value.contentItems) ? value.contentItems : [])
          .map((part: Json) => str(part.text))
          .join("\n"),
        ...(value.success === false ? { status: "failed" } : {}),
      });
    case "webSearch":
      return tool({
        title: "Web search",
        kind: "fetch",
        input: str(value.query),
      });
    default:
      return undefined;
  }
}

/** Codex turns, oldest first, as transcript turns for one conversation. */
export function codexTurns(
  turns: readonly Turn[],
  conversation: { channelId: string; root?: string },
): TranscriptTurn[] {
  return turns.map((turn) => {
    const startedAt = (turn.startedAt ?? 0) * 1000;
    let prompts = 0;
    const items = turn.items.flatMap((value) => {
      const next = item(
        value,
        startedAt,
        value.type === "userMessage" && prompts++ > 0,
      );
      return next ? [next] : [];
    });
    return {
      turnId: turn.id,
      channelId: conversation.channelId,
      threadRootId: conversation.root ?? null,
      triggeringEventIds: [],
      newSession: false,
      config: [],
      startedAt,
      ...(turn.completedAt ? { endedAt: turn.completedAt * 1000 } : {}),
      ...(turn.error?.message ? { error: turn.error.message } : {}),
      ...(turn.status === "interrupted" ? { stopReason: "interrupted" } : {}),
      partial: false,
      items,
    };
  });
}

/** A missing rollout (deleted, or never written) is not a read failure. */
const missing = (error: unknown) =>
  /not loaded|no rollout|not found/i.test(
    error instanceof Error ? error.message : String(error),
  );

/** The thread's latest turns from a short-lived app-server, or undefined when
 * Codex has no history for it on this device. */
export async function readTranscript(
  spawn: Spawn,
  threadId: string,
  conversation: { channelId: string; root?: string },
  signal: AbortSignal,
): Promise<CodexTranscript | undefined> {
  const rpc = new AppServer();
  const abort = () => void rpc.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.open(spawn);
    signal.throwIfAborted();
    let page: { data: Turn[]; nextCursor: string | null };
    try {
      page = await rpc.request<typeof page>("thread/turns/list", {
        threadId,
        limit: TURN_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      });
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    signal.throwIfAborted();
    const turns = [...page.data].reverse();
    return {
      turns: codexTurns(turns, conversation),
      unknownThread: 0,
      more: !!page.nextCursor,
      working: turns.at(-1)?.status === "inProgress",
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}
