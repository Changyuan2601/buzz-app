import { invoke } from "@tauri-apps/api/core";
import { type Credential, validCredentialValue } from "./browser";

/** Where a verified credential outlives the plugin: the OS credential store,
 * through the native `builderlab_session_*` commands (see
 * `src-tauri/src/builderlab_session.rs`). Only the session calls it. */
export type CredentialStore = {
  /** The saved credential, or `undefined` when there is none. One this
   * plugin cannot read is dropped, so a damaged item cannot fail every launch. */
  read(): Promise<Credential | undefined>;
  write(credential: Credential): Promise<void>;
  clear(): Promise<void>;
};

/** The saved form: one JSON object, so credential and account travel together. */
export function encodeCredential(credential: Credential) {
  return JSON.stringify({
    value: credential.value,
    account: credential.account,
  });
}

export function decodeCredential(text: string): Credential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { value, account } = parsed as Record<string, unknown>;
  if (typeof value !== "string" || !validCredentialValue(value))
    return undefined;
  if (!account || typeof account !== "object") return undefined;
  const { subject, email, canUseRemoteAgents } = account as Record<
    string,
    unknown
  >;
  if (typeof subject !== "string" || !subject.trim()) return undefined;
  return Object.freeze({
    value,
    account: Object.freeze({
      subject,
      email: typeof email === "string" ? email : "",
      canUseRemoteAgents: canUseRemoteAgents === true,
    }),
  });
}

export function nativeCredentialStore(
  send: <T>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T> = invoke,
): CredentialStore {
  const clear = () => send<void>("builderlab_session_clear");
  return {
    async read() {
      const saved = await send<string | null>("builderlab_session_read");
      if (typeof saved !== "string") return undefined;
      const credential = decodeCredential(saved);
      if (!credential) await clear();
      return credential;
    },
    write: (credential) =>
      send<void>("builderlab_session_replace", {
        blob: encodeCredential(credential),
      }),
    clear,
  };
}
