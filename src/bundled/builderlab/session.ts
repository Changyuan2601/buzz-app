import type { HostResponse } from "../../features/host/service";
import type { AuthenticatedRequest } from "../../features/federated-identity/service";
import type { FederatedSession } from "../../features/federated-identity/session";

/**
 * The signed-in account, one object per native session revision. No token.
 * `subject` scopes saved agents: the account email, which outlives a
 * revision; the revision only when the adapter reports no email.
 */
export type Credential = Readonly<{
  revision: string;
  origin: string;
  apiBasePath: string;
  account: Readonly<{ subject: string; email: string }>;
}>;
export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: Readonly<{
    subject: string;
    email: string;
    canUseRemoteAgents: boolean;
  }>;
  error?: string;
}>;

/**
 * Builderlab's view of the shared native session. The native side owns the
 * token; the renderer only learns whether remote agents were refused (403).
 */
export function createBuilderlabSession(federated: FederatedSession) {
  let disposed = false;
  let credential: Credential | undefined;
  let refused: string | undefined;
  let source: ReturnType<FederatedSession["snapshot"]> | undefined;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const project = () => {
    const next = federated.snapshot();
    if (next === source) return false;
    source = next;
    if (next.status !== "signed-in") credential = undefined;
    else if (credential?.revision !== next.account?.revision) {
      const identity = federated.identity();
      credential = Object.freeze({
        revision: identity.revision,
        origin: identity.origin,
        apiBasePath: identity.apiBasePath,
        account: Object.freeze({
          subject: next.account?.email || identity.revision,
          email: next.account?.email ?? "",
        }),
      });
    }
    state = Object.freeze({
      status: next.status,
      ...(credential
        ? {
            account: Object.freeze({
              ...credential.account,
              canUseRemoteAgents: refused !== credential.revision,
            }),
          }
        : {}),
      ...(next.error ? { error: next.error } : {}),
    });
    return true;
  };
  const stop = federated.subscribe(() => {
    if (disposed || !project()) return;
    for (const listener of listeners) listener();
  });
  project();
  return {
    available: () => !disposed && federated.available(),
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (disposed || !credential)
        throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    request(input: AuthenticatedRequest): Promise<HostResponse> {
      if (disposed) throw new Error("Builderlab session is closed.");
      return federated.request(input);
    },
    /** A 403 from Builderlab gates remote agents for this account until it changes. */
    refuseRemoteAgents(owner: Credential) {
      if (refused === owner.revision || credential !== owner) return;
      refused = owner.revision;
      source = undefined;
      project();
      for (const listener of listeners) listener();
    },
    /** Creation joins a login that is already running; it never cancels it. */
    async ensureSignedIn(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (credential) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(changed);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const changed = () => {
          if (!disposed && state.status === "pending") return;
          cleanup();
          if (credential && !disposed) resolve();
          else
            reject(
              new Error(
                disposed
                  ? "Builderlab session is closed."
                  : (state.error ?? "Sign-in canceled."),
              ),
            );
        };
        listeners.add(changed);
        signal.addEventListener("abort", abort, { once: true });
        if (state.status !== "pending")
          void federated.signIn().catch((error: unknown) => {
            if (!listeners.has(changed)) return;
            cleanup();
            reject(error);
          });
      });
    },
    signIn: () => federated.signIn(),
    cancel: () => federated.cancel(),
    signOut: () => federated.signOut(),
    dispose() {
      if (disposed) return;
      disposed = true;
      credential = undefined;
      state = Object.freeze({ status: "signed-out" });
      stop();
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}
export type BuilderlabSession = ReturnType<typeof createBuilderlabSession>;
