import type { MentionDraft } from "./mention-draft";

/** A composer's latest draft. Typing publishes here and only the leaves that
 * present draft-derived state subscribe, so keystrokes skip the chrome. */
export function composerDraftStore(initial: MentionDraft) {
  let value = initial;
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    /** Advances for each draft the editor did not author and must adopt. */
    revision: () => revision,
    set(next: MentionDraft, authored = false) {
      if (!authored) revision++;
      else if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type ComposerDraftStore = ReturnType<typeof composerDraftStore>;
