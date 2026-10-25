// While the word limits on `send` are tuned: how often they refuse, and what
// they refused. In memory only, for the Developer settings page; temporary.

export type LengthRefusal = Readonly<{
  audience: "everyone" | "details";
  words: number;
  /** What was over the limit: the whole message, or a details brief. */
  text: string;
  at: number;
}>;

/** The most recent refusals kept as examples. */
const KEPT = 20;

let counts = { everyone: 0, details: 0 };
let recent: readonly LengthRefusal[] = [];
let snapshot = { counts, recent };
const listeners = new Set<() => void>();

export const lengthRefusals = {
  record(refusal: Omit<LengthRefusal, "at">) {
    counts = { ...counts, [refusal.audience]: counts[refusal.audience] + 1 };
    recent = [{ ...refusal, at: Date.now() }, ...recent].slice(0, KEPT);
    snapshot = { counts, recent };
    for (const listener of listeners) listener();
  },
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
