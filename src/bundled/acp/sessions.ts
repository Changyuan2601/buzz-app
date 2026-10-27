// Each ACP agent's saved conversations on this device: when each was last
// active and, once its first prompt succeeded, the harness session to resume
// and how far it has seen. Resume pointers never sync.
import type {
  SavedConversation,
  SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

export const SESSIONS_KEY = "buzz.acp.sessions.v1";
/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

type All = Record<string, Record<string, SavedConversation>>;

/** One agent's saved conversations in `storage`. */
export function localSessions(
  storage: Storage,
  agent: string,
): Required<SessionStore> & {
  /** Saved conversations, most recently used first. */
  list(): [string, SavedConversation][];
} {
  const readAll = (): All => {
    try {
      const value = JSON.parse(storage.getItem(SESSIONS_KEY) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const sorted = (saved: Record<string, SavedConversation> = {}) =>
    Object.entries(saved)
      .filter(([, conversation]) => typeof conversation?.at === "number")
      .sort(([, a], [, b]) => b.at - a.at);
  const write = (edit: (saved: Record<string, SavedConversation>) => void) => {
    const all = readAll();
    const saved = { ...all[agent] };
    edit(saved);
    all[agent] = Object.fromEntries(sorted(saved).slice(0, SAVED_LIMIT));
    try {
      storage.setItem(SESSIONS_KEY, JSON.stringify(all));
    } catch (error) {
      console.warn("ACP sessions were not saved", error);
    }
  };
  const load = (key: string) => readAll()[agent]?.[key];
  return {
    list: () => sorted(readAll()[agent]),
    load,
    set: (key, conversation) =>
      write((saved) => {
        saved[key] = conversation;
      }),
    touch: (key, at) =>
      write((saved) => {
        saved[key] = { ...saved[key], at };
      }),
    advance: (key, { id, covered, context, overridden }) =>
      write((saved) => {
        const old = saved[key];
        const at = old?.at ?? Date.now();
        // A first success writes the pointer; later ones of the same session
        // move only its coverage, and flags only ever turn on.
        saved[key] =
          old?.id === id
            ? {
                ...old,
                at,
                covered,
                overridden: {
                  model: Boolean(old.overridden?.model || overridden.model),
                  effort: Boolean(old.overridden?.effort || overridden.effort),
                },
              }
            : { at, id, covered, context, overridden };
      }),
    drop: (key) =>
      write((saved) => {
        const old = saved[key];
        // The conversation stays listed; only its pointer goes.
        if (old) saved[key] = { at: old.at };
      }),
  };
}
