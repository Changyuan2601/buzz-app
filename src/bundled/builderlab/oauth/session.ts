import type { Credential } from "./browser";
import type { CredentialStore } from "./store";

export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: Credential["account"];
  error?: string;
}>;

/** Keeps a sign-in across launches. Only desktop builds have a store. */
export type SavedCredentials = Readonly<{
  store: CredentialStore;
  /** Asks the server about a saved credential; a rejection carries `status` 401. */
  verify(credential: Credential, signal: AbortSignal): Promise<Credential>;
}>;

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
// Native commands fail with plain strings, which name the store's problem.
const stored = (error: unknown) =>
  typeof error === "string" ? error : message(error, "secure storage failed");

/** One plugin lifetime owns the reusable credential; UI snapshots never contain
 * it. The in-memory credential is the one every request reads; the store is
 * written at sign-in and read once at launch. */
export function createOAuthSession(
  acquire: (signal: AbortSignal) => Promise<Credential>,
  saved?: SavedCredentials,
) {
  let credential: Credential | undefined;
  let attempt: AbortController | undefined;
  let checking: AbortController | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  // Writes and deletes run in order, so a sign-out's delete is never overtaken
  // by the sign-in's write. A store failure is logged; the session carries on
  // in memory, as before anything was saved.
  let queue: Promise<void> = Promise.resolve();
  const persist = (
    what: string,
    work: (store: CredentialStore) => Promise<void>,
  ) => {
    if (!saved) return;
    const { store } = saved;
    queue = queue
      .then(() => work(store))
      .catch((error: unknown) => {
        console.warn(`Builderlab sign-in ${what}`, stored(error));
      });
  };
  const reset = (next: LoginSnapshot = { status: "signed-out" }) => {
    attempt?.abort();
    attempt = undefined;
    checking?.abort();
    checking = undefined;
    credential = undefined;
    publish(next);
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
      if (!credential) throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    /** Creation joins Settings' login without owning or canceling that attempt. */
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
    /** Also forgets the saved sign-in; the next launch starts signed out. */
    signOut(error?: string) {
      reset(error ? { status: "signed-out", error } : undefined);
      persist("could not be forgotten", (store) => store.clear());
    },
    async signIn() {
      if (disposed || attempt) return;
      checking?.abort();
      checking = undefined;
      credential = undefined;
      const current = new AbortController();
      attempt = current;
      publish({ status: "pending" });
      try {
        const result = await acquire(current.signal);
        current.signal.throwIfAborted();
        if (attempt !== current || disposed) return;
        credential = result;
        persist("could not be saved", (store) => store.write(result));
        publish({ status: "signed-in", account: result.account });
      } catch (error) {
        if (attempt !== current || disposed) return;
        publish({
          status: "signed-out",
          error: message(error, "Sign-in failed. Try again."),
        });
      } finally {
        if (attempt === current) attempt = undefined;
      }
    },
    /** Sign in with the credential an earlier launch saved, if any, then ask
     * the server about it: one it rejects is forgotten, a changed account is
     * saved, and a server that cannot be reached leaves the sign-in as it was. */
    async restore(): Promise<void> {
      if (!saved) return;
      let loaded: Credential | undefined;
      try {
        loaded = await saved.store.read();
      } catch (error) {
        console.warn("Builderlab sign-in could not be read", stored(error));
        return;
      }
      if (!loaded || disposed || attempt || credential) return;
      credential = loaded;
      publish({ status: "signed-in", account: loaded.account });
      const current = new AbortController();
      checking = current;
      let verified: Credential;
      try {
        verified = await saved.verify(loaded, current.signal);
      } catch (error) {
        if (checking !== current || credential !== loaded) return;
        checking = undefined;
        if ((error as { status?: unknown }).status === 401)
          this.signOut("Your Builderlab sign-in expired. Sign in again.");
        return;
      }
      if (checking !== current || credential !== loaded) return;
      checking = undefined;
      if (JSON.stringify(verified.account) === JSON.stringify(loaded.account))
        return;
      credential = verified;
      persist("could not be saved", (store) => store.write(verified));
      publish({ status: "signed-in", account: verified.account });
    },
    /** Keeps the saved sign-in: disabling the plugin or closing Buzz is not
     * signing out. */
    dispose() {
      disposed = true;
      reset();
      listeners.clear();
    },
  };
}
export type OAuthSession = ReturnType<typeof createOAuthSession>;
