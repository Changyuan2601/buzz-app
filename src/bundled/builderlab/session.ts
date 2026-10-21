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
/** Whether this account may use remote agents, from `GET /v1/auth/me`. */
export type RemoteAgentsAccess = "checking" | "allowed" | "denied" | "failed";
export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: Readonly<{
    subject: string;
    email: string;
    remoteAgents: RemoteAgentsAccess;
  }>;
  error?: string;
}>;

/**
 * Builderlab's view of the shared native session. The native side owns the
 * token; each sign-in revision reads its remote-agent permission once.
 */
export function createBuilderlabSession(federated: FederatedSession) {
  let disposed = false;
  let credential: Credential | undefined;
  let access: RemoteAgentsAccess = "checking";
  let checking: Promise<void> = Promise.resolve();
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
      checking = checkAccess(credential);
    }
    state = Object.freeze({
      status: next.status,
      ...(credential
        ? {
            account: Object.freeze({
              ...credential.account,
              remoteAgents: access,
            }),
          }
        : {}),
      ...(next.error ? { error: next.error } : {}),
    });
    return true;
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const settle = (owner: Credential, next: RemoteAgentsAccess) => {
    if (disposed || credential !== owner || access === next) return;
    access = next;
    source = undefined;
    project();
    notify();
  };
  async function checkAccess(owner: Credential) {
    access = "checking";
    let next: RemoteAgentsAccess = "failed";
    try {
      const response = await federated.request({
        path: `${owner.apiBasePath}v1/auth/me`,
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (response.status >= 200 && response.status < 300) {
        const account = JSON.parse(response.body) as {
          capabilities?: { can_use_remote_agents?: unknown };
        };
        next =
          account?.capabilities?.can_use_remote_agents === true
            ? "allowed"
            : "denied";
      }
    } catch {
      // Not ready, never allowed: the provider offers a retry.
    }
    settle(owner, next);
  }
  const stop = federated.subscribe(() => {
    if (disposed || !project()) return;
    notify();
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
    /** The validated NIP-FI origin while signed in, for links to Builderlab. */
    origin: () => (disposed ? undefined : credential?.origin),
    credential() {
      if (disposed || !credential)
        throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    request(input: AuthenticatedRequest): Promise<HostResponse> {
      if (disposed) throw new Error("Builderlab session is closed.");
      return federated.request(input);
    },
    /** The permission once the current check has answered. */
    async remoteAgents(): Promise<RemoteAgentsAccess> {
      while (access === "checking" && credential && !disposed) {
        const current = checking;
        await current;
        if (current === checking) break;
      }
      return access;
    },
    /** Re-reads the permission after a failed check. */
    retryRemoteAgents() {
      if (disposed || !credential || access !== "failed") return;
      const owner = credential;
      settle(owner, "checking");
      checking = checkAccess(owner);
    },
    /** Beekeeper reported the feature disabled (or, as a fallback, a 403):
     * remote agents stay denied for this sign-in. */
    refuseRemoteAgents(owner: Credential) {
      settle(owner, "denied");
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
