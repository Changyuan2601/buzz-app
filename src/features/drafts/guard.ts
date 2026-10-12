/** App-owned protection for local edits. No draft contents or persistence here. */
export type DraftState = Readonly<{
  dirty: boolean;
  saving: boolean;
  revision?: unknown;
}>;
export type DraftNotice = Readonly<{ label: string; saving: boolean }>;
type Participant = {
  scope: object;
  label: string;
  state: DraftState;
  discard(): void;
};
type Pending = {
  entries: readonly Participant[];
  scope: object | readonly object[] | undefined;
  resolve(leave: boolean): void;
};

export function createDraftGuard() {
  const entries = new Set<Participant>();
  const listeners = new Set<() => void>();
  let pending: Pending | undefined;
  let notice: DraftNotice | undefined;
  let disposed = false;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const settle = (leave: boolean) => {
    const previous = pending;
    pending = undefined;
    notice = undefined;
    previous?.resolve(leave);
    emit();
  };
  const matches = (entry: Participant, scope?: object | readonly object[]) =>
    !scope ||
    (Array.isArray(scope)
      ? scope.includes(entry.scope)
      : scope === entry.scope);
  const risks = (scope?: object | readonly object[]) =>
    [...entries].filter(
      (entry) =>
        matches(entry, scope) && (entry.state.dirty || entry.state.saving),
    );
  return {
    snapshot: () => notice,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hasRisk(scope?: object | readonly object[]) {
      return risks(scope).length > 0;
    },
    register(scope: object, label: string, discard: () => void) {
      const entry: Participant = {
        scope,
        label,
        discard,
        state: { dirty: false, saving: false },
      };
      if (!disposed) entries.add(entry);
      return {
        update(state: DraftState) {
          if (!entries.has(entry)) return;
          if (
            entry.state.dirty === state.dirty &&
            entry.state.saving === state.saving &&
            entry.state.revision === state.revision
          )
            return;
          entry.state = state;
          // Never apply a delayed discard decision to a changed/save-completed editor.
          if (pending && matches(entry, pending.scope)) settle(false);
        },
        dispose() {
          entries.delete(entry);
          // Retirement (including account/access loss) cancels navigation intent,
          // not retirement itself. Never replay a queued action into a new session.
          if (pending && matches(entry, pending.scope)) settle(false);
        },
      };
    },
    request(scope?: object | readonly object[]): Promise<boolean> {
      if (disposed || pending) return Promise.resolve(false);
      const selected = risks(scope);
      if (!selected.length) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        pending = { entries: selected, scope, resolve };
        notice = {
          label:
            selected.length === 1
              ? (selected[0]?.label ?? "this editor")
              : "these editors",
          saving: selected.some((entry) => entry.state.saving),
        };
        emit();
      });
    },
    cancel() {
      settle(false);
    },
    discard() {
      const current = pending;
      if (
        !current ||
        current.entries.some(
          (entry) => !entries.has(entry) || entry.state.saving,
        )
      )
        return;
      // Detach before callbacks: reset state reports must not cancel this decision.
      pending = undefined;
      notice = undefined;
      try {
        for (const entry of current.entries) {
          entry.discard();
          entry.state = { dirty: false, saving: false };
        }
        current.resolve(true);
      } catch {
        current.resolve(false);
      }
      emit();
    },
    dispose() {
      disposed = true;
      entries.clear();
      settle(false);
      listeners.clear();
    },
  };
}
export type DraftGuard = ReturnType<typeof createDraftGuard>;
