// App-server history omits model-issued CodeMode calls. Restore those from
// Codex's own rollout, keeping its execution records alongside the script.
import type {
  ToolItem,
  TranscriptItem,
  TranscriptTurn,
} from "../../features/agents/activity-transcript";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const SCRIPT_STATUS: Record<string, string> = {
  "Script completed": "completed",
  "Script failed": "failed",
  "Script terminated": "terminated",
};
const display = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
const output = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((part) => {
          const block = object(part);
          return (block?.type === "input_text" || block?.type === "text") &&
            typeof block.text === "string"
            ? block.text
            : display(part);
        })
        .join("\n")
    : display(value);

export function restoreRecordedTools(turns: TranscriptTurn[], file: string) {
  const drafts = new Map(
    turns.map((turn) => [
      turn.turnId,
      {
        turn,
        existing: new Map(turn.items.map((item) => [item.id, item])),
        ordered: [] as TranscriptItem[],
        seen: new Set<string>(),
        ambiguous: false,
      },
    ]),
  );
  const calls = new Map<string, { item: ToolItem; owner: string }>();
  const active = new Map<ToolItem, string>();
  let turnId = "";
  for (const line of file.split("\n")) {
    let record: Json | undefined;
    try {
      record = object(JSON.parse(line));
    } catch {
      // A live file may end halfway through its next record.
      continue;
    }
    const payload = object(record?.payload);
    if (!payload) continue;
    if (
      record?.type === "turn_context" ||
      (record?.type === "event_msg" && payload.type === "task_started")
    ) {
      const next = str(payload.turn_id);
      if (next && next !== turnId) {
        turnId = next;
        active.clear();
      }
    }
    const draft = drafts.get(str(payload.turn_id) || turnId);
    if (record?.type === "event_msg" && payload.type === "item_completed") {
      const id = str(object(payload.item)?.id);
      const item = draft?.existing.get(id);
      if (!draft || !item || draft.seen.has(id)) continue;
      draft.seen.add(id);
      // There is no parent id in these records. Associate only inside a
      // single unfinished exec; concurrent/ambiguous calls stay independent.
      const parents = [...active].filter(
        ([, owner]) => owner === draft.turn.turnId,
      );
      const parent =
        !draft.ambiguous && parents.length === 1 ? parents[0]?.[0] : undefined;
      // A shell process can outlive its exec. Its completion timestamp alone
      // cannot establish ownership by the currently active script.
      const command = object(payload.item)?.type === "CommandExecution";
      const startedAt = payload.started_at_ms;
      if (
        parent &&
        (!command ||
          (typeof startedAt === "number" &&
            Number.isFinite(startedAt) &&
            startedAt >= parent.at)) &&
        (item.type === "tool" || (item.type === "message" && item.posted))
      ) {
        parent.children ??= [];
        parent.children.push(item);
      } else draft.ordered.push(item);
    }
    if (record?.type !== "response_item") continue;
    const callId = str(payload.call_id);
    if (!callId) continue;
    if (
      payload.type === "custom_tool_call_output" ||
      payload.type === "function_call_output"
    ) {
      const found = calls.get(callId);
      if (!found) continue;
      const item = found.item;
      item.output = output(payload.output);
      // A yielded exec has returned a cell handle, not its final result.
      // Its separately recorded wait calls retain that handle and output.
      const header = item.output.split("\n", 1)[0] ?? "";
      item.status = header.startsWith("Script running with cell ID ")
        ? "yielded"
        : (SCRIPT_STATUS[header] ?? "unknown");
      // Yielding returns before inner calls finish. Their later events cannot
      // safely be assigned to a subsequently active script in this turn.
      const owner = drafts.get(found.owner);
      if (owner && item.status === "yielded") owner.ambiguous = true;
      const at = Date.parse(str(record.timestamp));
      if (Number.isFinite(at)) item.completedAt = at;
      active.delete(item);
      continue;
    }
    if (
      !draft ||
      (payload.type !== "custom_tool_call" && payload.type !== "function_call")
    )
      continue;
    // Existing app-server calls already have richer status and rendering.
    if (draft.existing.has(callId)) continue;
    const at = Date.parse(str(record.timestamp));
    const name = [payload.namespace, payload.name].filter(Boolean).join(".");
    const isExec =
      payload.type === "custom_tool_call" &&
      (name === "exec" || name === "functions.exec");
    const isWait = name === "wait" || name === "functions.wait";
    // Only restore missing CodeMode calls. Other native calls may have an
    // adapter-owned id instead of call_id; never duplicate them by guessing.
    if (!isExec && !isWait) continue;
    const item: ToolItem = {
      id: callId,
      toolCallId: callId,
      at: Number.isFinite(at) ? at : draft.turn.startedAt,
      type: "tool",
      title: str(payload.name),
      kind: "execute",
      status: draft.turn.endedAt ? "unknown" : "in_progress",
      input: display(payload.input ?? payload.arguments),
      output: "",
      paths: [],
      diffs: [],
      truncated: false,
    };
    // Overlap remains ambiguous after one call returns: its completion events
    // can arrive while another script is the only active call.
    if ([...active.values()].includes(draft.turn.turnId))
      draft.ambiguous = true;
    calls.set(callId, { item, owner: draft.turn.turnId });
    draft.ordered.push(item);
    active.set(item, draft.turn.turnId);
  }
  for (const { turn, ordered, seen } of drafts.values()) {
    if (
      !ordered.some(
        (item) => item.type === "tool" && calls.has(item.toolCallId),
      )
    )
      continue;
    turn.items = [
      ...ordered,
      ...turn.items.filter((item) => !seen.has(item.id)),
    ];
  }
}
