import type { ReadTarget } from "./read-state-model";

/** A conversation projected from the unread owner's bounded verified evidence. */
export type InboxItem = Readonly<{
  id: string;
  channelId: string;
  target: ReadTarget;
  /** Oldest observed unread message, otherwise newest relevant message. */
  messageId: string;
  latestMessageId: string;
  /** Exact verified group members, for pending preview evidence across regrouping. */
  messageIds: readonly string[];
  rootId?: string;
  authorId: string;
  workflowOwnerId?: string | undefined;
  preview: string;
  /** The message the preview shows, which may be outside `messageIds`. */
  previewMessageId?: string;
  createdAt: number;
  mentioned: boolean;
  /** Verified group members with time and viewer-mention classification. */
  messages: readonly Readonly<{
    id: string;
    createdAt: number;
    mentioned: boolean;
  }>[];
  /** The same conversation projected from explicit mention evidence only. */
  mention?: InboxItem | undefined;
  thread: boolean;
  unreadCount: number;
  manual: boolean;
  /** Explicit prefixes; a thread prefix never acknowledges its top-level root. */
  readThrough: readonly Readonly<{ target: ReadTarget; messageId: string }>[];
}>;
export type InboxSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxItem[];
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;

/** Inbox's row rules, shared by every reader of `unread.inbox()` so they stay
 * one policy. Unread: observed unread evidence, or marked unread here. */
export const inboxItemUnread = (
  item: Pick<InboxItem, "unreadCount" | "manual">,
) => item.unreadCount > 0 || item.manual;

/** Whether a row's text awaits its edit/deletion closure (`inboxFeed`'s
 * `incomplete`), so readers withhold its preview. */
export const inboxPreviewPending = (
  item: Pick<InboxItem, "previewMessageId" | "messageIds">,
  incomplete: readonly string[],
) =>
  [item.previewMessageId, ...item.messageIds].some(
    (id) => id !== undefined && incomplete.includes(id),
  );
