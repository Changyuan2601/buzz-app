import type { RelaySession } from "../../features/relay/session";
import type { PanelOpening } from "../../features/panels/service";
import type { ConversationTab, TabWorkspaceState } from "./useChannelTabState";

export type SavedPanel = {
  key: string;
  target: string;
  channelId: string;
  rootId?: string | undefined;
  index: number;
};
// Restoring these readers has no process/setup lifecycle. Channel tools and
// arbitrary contributed panels require their own restoration contract.
const restorablePanels = new Set([
  "buzz.profiles/profile",
  "buzz.github/object",
]);
export const restorablePanel = (entry: PanelOpening) =>
  restorablePanels.has(entry.panel.key) && !entry.channelContext;
export const tabWorkspaceStorageKey = (scope: string) =>
  `buzz-tab-workspaces.v1:${scope}`;
const storageKey = (session: RelaySession) =>
  session.scope && session.viewer
    ? tabWorkspaceStorageKey(session.scope)
    : undefined;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: unknown) =>
  value === undefined || typeof value === "string";
const selection = (value: unknown) =>
  record(value) &&
  typeof value.selected === "string" &&
  optionalString(value.mainSelected) &&
  typeof value.paneOpen === "boolean";

function tabOf(value: unknown): ConversationTab | undefined {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.channelId !== "string" ||
    !optionalString(value.messageId)
  )
    return;
  const base = { id: value.id, channelId: value.channelId };
  if (value.kind === "conversation")
    return {
      ...base,
      kind: "conversation",
      messageId: value.messageId as string | undefined,
      ...(value.markRead === false && { markRead: false }),
    };
  if (
    value.kind === "thread" &&
    typeof value.messageId === "string" &&
    optionalString(value.rootId) &&
    optionalString(value.name) &&
    (value.pane === undefined || value.pane === "main" || value.pane === "side")
  )
    return {
      ...base,
      kind: "thread",
      messageId: value.messageId,
      rootId: value.rootId as string | undefined,
      name: value.name as string | undefined,
      pane: value.pane as "main" | "side" | undefined,
    };
}
function savedPanel(value: unknown): value is SavedPanel {
  return (
    record(value) &&
    typeof value.key === "string" &&
    restorablePanels.has(value.key) &&
    typeof value.target === "string" &&
    typeof value.channelId === "string" &&
    optionalString(value.rootId) &&
    Number.isSafeInteger(value.index) &&
    (value.index as number) >= 0
  );
}
function stateOf(
  value: unknown,
  workspaceKey: string,
): TabWorkspaceState | undefined {
  if (
    !record(value) ||
    !selection(value) ||
    !Array.isArray(value.tabs) ||
    !Array.isArray(value.entries) ||
    !optionalString(value.visit) ||
    (value.left !== undefined && typeof value.left !== "boolean") ||
    (value.mainEntries !== undefined &&
      (!Array.isArray(value.mainEntries) ||
        !value.mainEntries.every((id) => typeof id === "string"))) ||
    (value.visits !== undefined &&
      (!record(value.visits) || !Object.values(value.visits).every(selection)))
  )
    return;
  // Preserve domain-owned visit associations alongside layout snapshots. They
  // contain addresses only; never hydrate runtime panel objects or requests.
  for (const [field, keys] of [
    ["routedVisits", ["channelId", "messageId", "rootId"]],
    ["detailVisits", ["channelId", "target"]],
  ] as const) {
    const visits = value[field];
    if (
      visits !== undefined &&
      (!record(visits) ||
        !Object.values(visits).every(
          (visit) =>
            record(visit) &&
            keys.every((key) => typeof visit[key] === "string"),
        ))
    )
      return;
  }
  return {
    ...value,
    selected: value.selected as string,
    paneOpen: value.paneOpen as boolean,
    tabs: value.tabs.flatMap((raw) => {
      const tab = tabOf(raw);
      return tab ? [tab] : [];
    }),
    entries: [],
    pendingEntries: value.entries.filter(savedPanel),
    thread: undefined,
    settings:
      record(value.settings) &&
      typeof value.settings.channelId === "string" &&
      workspaceKey === JSON.stringify(["messages", value.settings.channelId])
        ? { id: crypto.randomUUID(), channelId: value.settings.channelId }
        : undefined,
    sidePanel: false,
  } as TabWorkspaceState;
}

export function readTabWorkspaces(
  session: RelaySession,
): Record<string, TabWorkspaceState> {
  const key = storageKey(session);
  if (!key) return {};
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!record(raw) || raw.version !== 1 || !record(raw.workspaces)) return {};
    return Object.fromEntries(
      Object.entries(raw.workspaces).flatMap(([key, value]) => {
        const state = stateOf(value, key);
        return state ? [[key, state]] : [];
      }),
    );
  } catch {
    return {};
  }
}
export function saveTabWorkspaces(
  session: RelaySession,
  states: Record<string, TabWorkspaceState>,
) {
  const key = storageKey(session);
  if (!key) return;
  try {
    const workspaces = Object.fromEntries(
      Object.entries(states).map(([key, state]) => {
        const {
          entries,
          pendingEntries,
          thread,
          settings,
          sidePanel,
          ...saved
        } = state;
        const panels: SavedPanel[] = entries
          .filter(restorablePanel)
          .map((entry, index) => ({
            key: entry.panel.key,
            target: entry.target,
            channelId: entry.channelId,
            rootId: entry.rootId,
            index,
          }));
        for (const pending of [...(pendingEntries ?? [])].sort(
          (a, b) => a.index - b.index,
        ))
          panels.splice(Math.min(pending.index, panels.length), 0, pending);
        return [
          key,
          {
            ...saved,
            settings: settings?.channelId
              ? { channelId: settings.channelId }
              : undefined,
            tabs: state.tabs.flatMap((tab) => {
              const saved = tabOf(tab);
              return saved ? [saved] : [];
            }),
            entries: panels.map((panel, index) => ({ ...panel, index })),
          },
        ];
      }),
    );
    sessionStorage.setItem(key, JSON.stringify({ version: 1, workspaces }));
  } catch {
    // Blocked storage or a full quota must not prevent editing live tabs.
  }
}
