import type { Credential } from "./browser";

export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: Credential["account"];
  error?: string;
}>;

export const SESSION_EXPIRED =
  "Your Builderlab session expired. Sign in again.";
/** A credential is treated as gone this long before the server's expiry, so
 * work started at the boundary does not land on an expired session. */
const LEEWAY_MS = 60_000;
/** setTimeout's largest delay; a longer wait re-arms when it elapses. */
const MAX_DELAY_MS = 2_147_483_647;

/** One plugin lifetime owns the reusable credential; UI snapshots never contain it. */
export function createOAuthSession(
  acquire: (signal: AbortSignal) => Promise<Credential>,
) {
  let credential: Credential | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt: AbortController | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const expired = (held: Credential) =>
    held.expiresAt - LEEWAY_MS <= Date.now();
  const drop = () => {
    clearTimeout(timer);
    timer = undefined;
    credential = undefined;
  };
  const reset = (error?: string) => {
    attempt?.abort();
    attempt = undefined;
    drop();
    publish(error ? { status: "signed-out", error } : { status: "signed-out" });
  };
  /** Ends the session the server no longer honours. Concurrent 401s and the
   * timer report one expiry. */
  const expire = () => {
    if (state.status === "signed-out" && state.error === SESSION_EXPIRED)
      return;
    reset(SESSION_EXPIRED);
  };
  /** Flips to signed-out at expiry without waiting for a request to fail. */
  const arm = () => {
    if (!credential) return;
    const remaining = credential.expiresAt - LEEWAY_MS - Date.now();
    timer = setTimeout(
      remaining > MAX_DELAY_MS ? arm : expire,
      Math.min(Math.max(remaining, 0), MAX_DELAY_MS),
    );
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      // A late timer (the clock moved while Buzz slept) still never hands out
      // an expired credential.
      if (credential && expired(credential)) expire();
      if (!credential) throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    /** Creation joins Settings' login without owning or canceling that attempt. */
    async ensureSignedIn(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (credential && !expired(credential)) return;
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
          if (state.status === "pending") return;
          cleanup();
          if (credential) resolve();
          else reject(new Error(state.error ?? "Sign-in canceled."));
        };
        listeners.add(changed);
        signal.addEventListener("abort", abort, { once: true });
        void this.signIn();
      });
    },
    cancel: () => reset(),
    signOut: () => reset(),
    expire,
    async signIn() {
      if (disposed || attempt) return;
      drop();
      const current = new AbortController();
      attempt = current;
      publish({ status: "pending" });
      try {
        const result = await acquire(current.signal);
        current.signal.throwIfAborted();
        if (attempt !== current || disposed) return;
        credential = result;
        publish({ status: "signed-in", account: result.account });
        arm();
      } catch (error) {
        if (attempt !== current || disposed) return;
        publish({
          status: "signed-out",
          error:
            error instanceof Error
              ? error.message
              : "Sign-in failed. Try again.",
        });
      } finally {
        if (attempt === current) attempt = undefined;
      }
    },
    dispose() {
      disposed = true;
      reset();
      listeners.clear();
    },
  };
}
export type OAuthSession = ReturnType<typeof createOAuthSession>;
