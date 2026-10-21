import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type PowerState = Readonly<{
  supported: boolean;
  active: boolean;
  expired: boolean;
  error?: string | null;
}>;
export type KeepAwakePlatform = {
  open(changed: (state: PowerState) => void): Promise<number>;
  set(lease: number, active: boolean): Promise<PowerState>;
};
export type KeepAwakeSnapshot = PowerState & {
  enabled: boolean;
  working: boolean;
  pending: boolean;
  saveError: string | null;
};
const key = "buzz-agent-keep-awake.v1";
function nativePlatform(): KeepAwakePlatform | undefined {
  if (!isTauri()) return;
  return {
    open(changed) {
      const channel = new Channel<PowerState>();
      channel.onmessage = changed;
      return invoke("agent_keep_awake_open", { channel });
    },
    set: (lease, active) => invoke("agent_keep_awake_set", { lease, active }),
  };
}

/** App-owned execution, not display activity or process presence. Native owns
 * the power assertion and its inactivity cap, even if the renderer stops. */
export function createKeepAwake(
  platform = nativePlatform(),
  storage?: Pick<Storage, "getItem" | "setItem">,
) {
  let enabled = false;
  try {
    storage ??= globalThis.localStorage;
    enabled = storage.getItem(key) === "on";
  } catch {
    // Missing or unreadable preference never keeps a computer awake.
  }
  let state: KeepAwakeSnapshot = Object.freeze({
    supported: !!platform,
    active: false,
    expired: false,
    enabled,
    working: false,
    pending: !!platform,
    saveError: null,
  });
  const listeners = new Set<() => void>();
  const work = new Set<() => void>();
  let closed = false;
  let lease: number | undefined;
  let revision = 0;
  let applied = -1;
  let writing: Promise<void> | undefined;
  const publish = (patch: Partial<KeepAwakeSnapshot>) => {
    state = Object.freeze({ ...state, ...patch });
    if (!closed) for (const listener of listeners) listener();
  };
  const failure = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const wanted = () => !closed && state.enabled && work.size > 0;
  function project() {
    if (!platform || lease === undefined || writing || applied === revision)
      return;
    writing = (async () => {
      do {
        const attempted = revision;
        publish({ pending: !closed });
        try {
          const power = await platform.set(lease as number, wanted());
          publish({ ...power, error: power.error ?? null, pending: false });
        } catch (error) {
          publish({ error: failure(error), pending: false });
        }
        // No automatic retry on failure. New work or explicit Retry may retry.
        applied = attempted;
      } while (applied !== revision);
    })().finally(() => {
      writing = undefined;
      if (applied !== revision) project();
    });
  }
  const changed = () => {
    revision++;
    publish({ working: work.size > 0 });
    project();
  };
  let opening: Promise<void> | undefined;
  function open() {
    if (!platform || opening || lease !== undefined) return;
    opening = platform
      .open((power) => {
        if (!closed) publish(power);
      })
      .then((value) => {
        lease = value;
        project();
      })
      .catch((error) => publish({ error: failure(error), pending: false }))
      .finally(() => {
        opening = undefined;
      });
  }
  open();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled(value: boolean) {
      if (closed || !state.supported) return;
      let saveError: string | null = null;
      try {
        if (!storage) throw new Error("Storage unavailable");
        storage.setItem(key, value ? "on" : "off");
        if (storage.getItem(key) !== (value ? "on" : "off"))
          throw new Error("Preference was not retained");
      } catch {
        saveError =
          "This choice is active, but could not be saved on this device. Try again.";
      }
      publish({ enabled: value, saveError });
      open();
      changed();
    },
    retry() {
      this.setEnabled(state.enabled);
    },
    /** Covers one real run or handed-off operation. Retirement always releases
     * its demand; duplicate or late callbacks cannot recreate it. */
    begin(signal: AbortSignal) {
      const finish = () => {
        signal.removeEventListener("abort", finish);
        if (work.delete(finish)) changed();
      };
      if (!closed && !signal.aborted) {
        work.add(finish);
        signal.addEventListener("abort", finish, { once: true });
        changed();
      }
      return {
        finish,
        pulse() {
          if (work.has(finish)) changed();
        },
      };
    },
    async dispose() {
      closed = true;
      for (const finish of [...work]) finish();
      changed();
      listeners.clear();
      await opening;
      project();
      while (writing) await writing;
    },
  };
}
export type KeepAwake = ReturnType<typeof createKeepAwake>;
