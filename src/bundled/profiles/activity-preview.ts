import type { ActivityRecord } from "../../features/agents/activity-records";

type PreviewItem = {
  id: string;
  label: string;
  text: string;
  timestamp: number;
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const clipped = (value: string) => {
  if (value.length <= 600) return value;
  let start = value.length - 600;
  // Keep the size cap without cutting a UTF-16 surrogate pair in half.
  const previous = value.charCodeAt(start - 1);
  const current = value.charCodeAt(start);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  )
    start++;
  return `…${value.slice(start)}`;
};

/** A small display projection, not a transcript store. Only explicit assistant
 * ACP message text and tool titles are shown; prompts, thoughts, arguments and
 * raw results stay out of this preview. Batch children require their own exact
 * channel scope. */
export function activityPreview(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  agent: string,
  channelId: string,
): PreviewItem[] {
  if (!channelId) return [];
  const items = new Map<string, PreviewItem>();
  const segments = new Map<string, number>();
  for (const row of records) {
    if (row.agent !== agent) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.plaintext);
    } catch {
      continue;
    }
    const envelope = object(raw);
    const children =
      envelope.kind === "batch" ? object(envelope.payload).events : [envelope];
    if (!Array.isArray(children)) continue;
    // Read only allowlisted fields: diagnostic formatting traverses excluded
    // raw results and can amplify deeply nested input before it is filtered.
    for (const [index, child] of children.entries()) {
      const event = object(child);
      if (event.channelId !== channelId) continue;
      const payload = object(event.payload);
      if (event.kind !== "acp_read" || payload.method !== "session/update")
        continue;
      const update = object(object(payload.params).update);
      const kind = update.sessionUpdate;
      const scope = [text(event.sessionId), text(event.turnId)];
      const scopeKey = JSON.stringify(scope);
      const parsed = Date.parse(text(event.timestamp));
      const timestamp =
        Number.isFinite(parsed) && parsed <= row.receivedAt + 5000
          ? parsed
          : row.receivedAt;
      let id: string;
      let label: string;
      let content: string;
      if (kind === "agent_message_chunk") {
        const block = object(update.content);
        if (block.type !== "text" || !text(block.text)) continue;
        // Without a message or turn identity, don't join unrelated chunks.
        const messageId = text(update.messageId);
        id = JSON.stringify([
          ...scope,
          "message",
          messageId,
          messageId ? "" : text(event.turnId) || `${row.id}:${index}`,
          messageId ? 0 : (segments.get(scopeKey) ?? 0),
        ]);
        label = "Assistant";
        content = clipped((items.get(id)?.text ?? "") + text(block.text));
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        if (!text(update.toolCallId)) continue;
        // A tool seals only this turn's unkeyed message. Explicit message IDs
        // still join across interleaved tool and message updates.
        segments.set(scopeKey, (segments.get(scopeKey) ?? 0) + 1);
        id = JSON.stringify([...scope, "tool", update.toolCallId]);
        const previous = items.get(id);
        content = clipped(text(update.title) || previous?.text || "Tool call");
        label =
          update.status === "completed"
            ? "Tool completed"
            : update.status === "failed"
              ? "Tool error"
              : update.status === "in_progress"
                ? "Using tool"
                : update.status === "pending"
                  ? "Tool pending"
                  : previous?.label || "Tool";
      } else continue;
      // Preserve interleaved chunks while folding the bounded journal; return only
      // the three most recently updated items.
      items.delete(id);
      items.set(id, { id, label, text: content, timestamp });
    }
  }
  return [...items.values()].slice(-3);
}
