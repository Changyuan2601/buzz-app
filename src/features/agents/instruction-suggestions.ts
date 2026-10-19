import type { InstructionProposal } from "./onboarding";

type Permission = { type: string; basedOn: string; channelId: string };
/** Explicitly requested, bounded in-memory proposals. This never saves agent config. */
export class InstructionSuggestions {
  private permissions = new Map<string, Permission>();
  private proposals = new Map<string, InstructionProposal>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (key: string) => this.proposals.get(key);
  allow(key: string, permission: Permission) {
    this.permissions.delete(key);
    this.proposals.delete(key);
    this.permissions.set(key, permission);
    while (this.permissions.size > 64) {
      const oldest = this.permissions.keys().next().value;
      if (oldest) {
        this.permissions.delete(oldest);
        this.proposals.delete(oldest);
      }
    }
    this.notify();
  }
  propose(
    key: string,
    text: string,
    channelId: string,
    type: string,
    saved: string,
  ) {
    const allowed = this.permissions.get(key);
    if (!allowed || allowed.channelId !== channelId || allowed.type !== type)
      throw new Error(
        "The owner must choose guided customization in this Solo chat first.",
      );
    if (saved !== allowed.basedOn)
      throw new Error(
        "The saved instructions changed during customization. Ask the owner to restart guided customization from the card.",
      );
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 20_000 ||
      text.includes(String.fromCharCode(0))
    )
      throw new Error(
        "Proposed instructions must contain 1–20,000 characters and no null bytes.",
      );
    const proposal = Object.freeze({
      id: crypto.randomUUID(),
      text: text.trim(),
      basedOn: saved,
      type,
    });
    this.permissions.delete(key);
    this.proposals.set(key, proposal);
    this.notify();
  }
  dismiss(key: string, id: string) {
    if (this.proposals.get(key)?.id !== id) return;
    this.proposals.delete(key);
    this.notify();
  }
  clearScope(scope: string) {
    const prefix = `${scope}:`;
    for (const key of this.permissions.keys())
      if (key.startsWith(prefix)) this.permissions.delete(key);
    for (const key of this.proposals.keys())
      if (key.startsWith(prefix)) this.proposals.delete(key);
    this.notify();
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
}
