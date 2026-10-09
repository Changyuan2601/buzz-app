import { readView } from "../../shared/view-state";
import type { MentionDraft } from "../messages/mention-draft";
import type { SessionSetup } from "./workspace";

export type PendingStart = {
  id: string;
  text: string;
  draft?: MentionDraft;
  agent?: string;
  invitationId?: string;
  creationId?: string;
  messageId?: string;
  setup?: SessionSetup;
  setupDone?: boolean;
};
const sessionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function readPending(
  scope: string,
  draftKey: string,
): PendingStart | undefined {
  const value = readView<Partial<PendingStart> | null>(
    scope,
    `${draftKey}:pending`,
    null,
  );
  if (
    !value ||
    typeof value.id !== "string" ||
    !sessionId.test(value.id) ||
    typeof value.text !== "string" ||
    value.text.length > 16000
  )
    return;
  if (
    [value.creationId, value.messageId, value.invitationId, value.agent].some(
      (id) =>
        id !== undefined &&
        (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)),
    )
  )
    return;
  return value as PendingStart;
}

/** Locate the existing receipt, including one whose section has since been deleted. */
export function pendingSessionDraft(
  scope: string,
  channelId: string,
): string | undefined {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith("buzz-view.v1:")) continue;
      let pair: unknown;
      try {
        pair = JSON.parse(key.slice("buzz-view.v1:".length));
      } catch {
        continue;
      }
      if (
        !Array.isArray(pair) ||
        pair[0] !== scope ||
        typeof pair[1] !== "string"
      )
        continue;
      const draftKey = pair[1].endsWith(":pending") ? pair[1].slice(0, -8) : "";
      if (draftKey !== "sessions" && !draftKey.startsWith("sessions:section:"))
        continue;
      if (readPending(scope, draftKey)?.id === channelId) return draftKey;
    }
  } catch {
    /* Storage unavailable. */
  }
  return undefined;
}
