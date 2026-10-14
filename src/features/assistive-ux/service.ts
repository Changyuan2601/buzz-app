import { Service, type Context } from "@deepseek-ai/cordis";
import {
  ASSISTIVE_EXPERIENCES,
  type AssistiveFacts,
  type AssistiveExperienceId,
} from "./catalog";

export interface AssistiveUx {
  /** UI-neutral eligibility; reading never records exposure or completes work. */
  snapshot<Id extends AssistiveExperienceId>(
    viewer: string | undefined,
    id: Id,
    facts: AssistiveFacts[Id],
  ): boolean;
  subscribe(listener: () => void): () => void;
  dismiss(
    viewer: string,
    id: AssistiveExperienceId,
  ): "saved" | "unsaved" | "unavailable";
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    assistiveUx: AssistiveUx;
  }
}

const PREFIX = "buzz-assistive-ux.v1:";
const validViewer = (viewer: string | undefined): viewer is string =>
  typeof viewer === "string" && /^[a-f0-9]{64}$/.test(viewer);

/** Always-on app service. Account + experience markers avoid cross-window map overwrites. */
export class AssistiveUxService extends Service implements AssistiveUx {
  private readonly listeners = new Set<() => void>();
  private readonly dismissed = new Map<string, "saved" | "unsaved">();
  private closed = false;
  private readonly host = typeof window === "undefined" ? undefined : window;

  constructor(ctx: Context) {
    super(ctx, "assistiveUx");
    ctx.effect(() => {
      const changed = (event: StorageEvent) => {
        if (event.key !== null && !event.key.startsWith(PREFIX)) return;
        try {
          if (event.storageArea !== this.host?.localStorage) return;
        } catch {
          // A blocked read should not stop an in-memory dismissal.
        }
        for (const [key, state] of this.dismissed)
          if (state === "saved" && (event.key === null || event.key === key))
            this.dismissed.delete(key);
        this.notify();
      };
      this.host?.addEventListener("storage", changed);
      return () => {
        this.closed = true;
        this.host?.removeEventListener("storage", changed);
        this.listeners.clear();
        this.dismissed.clear();
      };
    });
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = <Id extends AssistiveExperienceId>(
    viewer: string | undefined,
    id: Id,
    facts: AssistiveFacts[Id],
  ): boolean => {
    const experience = Object.hasOwn(ASSISTIVE_EXPERIENCES, id)
      ? ASSISTIVE_EXPERIENCES[id]
      : undefined;
    if (this.closed || !validViewer(viewer) || !experience?.eligible(facts))
      return false;
    const key = `${PREFIX}${viewer}:${id}`;
    if (this.dismissed.has(key)) return false;
    try {
      if (this.host?.localStorage.getItem(key) === "dismissed") return false;
    } catch {
      // Unknown evidence leaves non-authoritative assistance eligible.
    }
    return true;
  };

  dismiss(viewer: string, id: AssistiveExperienceId) {
    if (
      this.closed ||
      !validViewer(viewer) ||
      !Object.hasOwn(ASSISTIVE_EXPERIENCES, id)
    )
      return "unavailable" as const;
    const key = `${PREFIX}${viewer}:${id}`;
    let saved = false;
    try {
      this.host?.localStorage.setItem(key, "dismissed");
      saved = this.host?.localStorage.getItem(key) === "dismissed";
    } catch {
      // Honor the explicit action for this run, without claiming persistence.
    }
    this.dismissed.set(key, saved ? "saved" : "unsaved");
    this.notify();
    return saved ? ("saved" as const) : ("unsaved" as const);
  }
}
