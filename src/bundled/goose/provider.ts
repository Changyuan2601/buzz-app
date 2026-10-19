import type { AgentProviderSnapshot } from "../../features/agents/service";
import { config, type Config } from "./runtime";
import type { GooseSetup } from "./setup";

type Choice = { provider: string; model: string };
const KEY = "buzz.goose.provider-defaults.v1";

/** Device-wide selection, separate from goose's secret store and per-agent config. */
export class GooseProvider {
  private state: AgentProviderSnapshot = { readiness: "checking" };
  private listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private current: Choice;
  private disposed = false;
  private revision = 0;

  constructor(
    private readonly setup: GooseSetup,
    private readonly storage: Storage = localStorage,
  ) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
      this.current =
        saved &&
        typeof saved === "object" &&
        "provider" in saved &&
        typeof saved.provider === "string" &&
        "model" in saved &&
        typeof saved.model === "string"
          ? { provider: saved.provider, model: saved.model }
          : { provider: "", model: "" };
    } catch {
      this.current = { provider: "", model: "" };
    }
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  choice = () => this.current;
  private set(state: AgentProviderSnapshot) {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  check = () => {
    if (this.pending) return this.pending;
    if (this.state.blocking) return Promise.resolve();
    const revision = ++this.revision;
    this.set({ readiness: "checking" });
    const pending = this.setup.providers().then(
      (listing) => {
        if (revision !== this.revision) return;
        const id = this.current.provider || listing.defaults.provider;
        const selected = listing.providers.find(
          (provider) => provider.id === id,
        );
        this.set(
          selected?.configured
            ? { readiness: "ready" }
            : { readiness: "attention", attentionLabel: "Set up Goose" },
        );
      },
      () => {
        if (revision === this.revision)
          this.set({ readiness: "attention", attentionLabel: "Set up Goose" });
      },
    );
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  };
  /** Verify the selection before saving it; no credentials are stored here. */
  async save(choice: Choice, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Goose provider setup is unavailable.");
    if (this.state.blocking) throw new Error("Goose setup is already running.");
    // A foreground save supersedes an older read without waiting on keychain UI.
    this.revision++;
    const before =
      this.state.readiness === "checking"
        ? { readiness: "attention" as const, attentionLabel: "Set up Goose" }
        : this.state;
    this.set({ ...before, blocking: true });
    try {
      const tested = await this.setup.test(choice, signal);
      signal.throwIfAborted();
      if (this.disposed)
        throw new Error("Goose provider setup is unavailable.");
      if (!tested.ok) throw new Error(tested.message);
      this.storage.setItem(KEY, JSON.stringify(choice));
      this.current = { ...choice };
      this.set({ readiness: "ready" });
    } finally {
      if (this.state.blocking) {
        const { blocking: _, ...state } = this.state;
        this.set(state);
      }
    }
  }
  resolve = (raw: unknown): Config => {
    const explicit = config(raw);
    return {
      ...explicit,
      provider: explicit.provider || this.current.provider,
      model: explicit.model || (explicit.provider ? "" : this.current.model),
    };
  };
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
