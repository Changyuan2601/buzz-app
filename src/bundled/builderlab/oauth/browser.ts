import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Host } from "../../../features/host/service";

export const browserLoginAvailable = () => isTauri();

/** The configured HTTPS origin is granted to this plugin at build time. */
export function oauthTarget(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Builderlab sign-in is not configured for this Buzz build.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error(
      "This Buzz build does not support the configured Builderlab sign-in address.",
    );
  return `${url.href.replace(/\/$/, "")}/api/goose`;
}

export type Credential = Readonly<{
  value: string;
  account: Readonly<{
    subject: string;
    email: string;
    canUseRemoteAgents: boolean;
  }>;
}>;

/** What the server issues: one printable ASCII token of up to 4 KiB. */
export function validCredentialValue(value: string) {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    [...value].every(
      (character) =>
        character.charCodeAt(0) > 32 && character.charCodeAt(0) <= 126,
    )
  );
}

/** A JSON request to the sign-in API. A refusal's error carries its HTTP
 * `status`, so a credential the server rejects (401) can be told from a
 * failure to reach it. Never forwards provider bodies or credentials. */
async function request(
  host: Host,
  target: string,
  path: string,
  signal: AbortSignal,
  credential?: string,
  body?: string,
) {
  signal.throwIfAborted();
  const response = await host.request({
    url: `${target}${path}`,
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(credential ? { "X-BB-Session-Credential": credential } : {}),
    },
    ...(body ? { body } : {}),
  });
  signal.throwIfAborted();
  if (response.status < 200 || response.status >= 300)
    throw Object.assign(
      new Error(
        `Builderlab sign-in failed (HTTP ${response.status}). Try again.`,
      ),
      { status: response.status },
    );
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error("Builderlab returned an invalid sign-in response.");
  }
}

/** The account behind a credential, from `/v1/auth/me`: at sign-in, and again
 * at launch for a saved credential, whose capabilities may have changed. */
export async function verifyCredential(
  host: Host,
  value: string,
  signal: AbortSignal,
  target = oauthTarget(),
): Promise<Credential> {
  const account = await request(host, target, "/v1/auth/me", signal, value);
  if (typeof account?.subject !== "string" || !account.subject.trim())
    throw new Error("Builderlab did not return a valid account.");
  return Object.freeze({
    value,
    account: Object.freeze({
      subject: account.subject,
      email: typeof account.email === "string" ? account.email.trim() : "",
      canUseRemoteAgents: account.capabilities?.can_use_remote_agents === true,
    }),
  });
}

export type OAuthCallback = Readonly<{
  parameters: readonly (readonly [string, string])[];
}>;
export type BrowserBridge = {
  begin(options: {
    authorizationUrl: string;
    callbackPath: string;
    useState?: boolean;
  }): Promise<{ id: string; callbackUrl: string }>;
  wait(id: string): Promise<OAuthCallback>;
  cancel(id: string): Promise<void>;
};
const nativeBridge: BrowserBridge = {
  begin: (options) => invoke("oauth_callback_begin", options),
  wait: (id) => invoke("oauth_callback_wait", { id }),
  cancel: (id) => invoke("oauth_callback_cancel", { id }),
};

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Acquire and verify a credential. No UI, storage, or authenticated API consumers. */
export async function browserCredential(
  host: Host,
  signal: AbortSignal,
  bridge: BrowserBridge = nativeBridge,
): Promise<Credential> {
  signal.throwIfAborted();
  const target = oauthTarget();
  let id: string | undefined;
  const path = `/callback/${crypto.randomUUID()}`;
  const login = new URL(`${target}/v1/auth/login`);
  const cancel = () => {
    if (id) void bridge.cancel(id).catch(() => {});
  };
  try {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    signal.throwIfAborted();
    login.search = new URLSearchParams({
      type: "cli",
      product: "builderlab",
      code_challenge: base64url(new Uint8Array(digest)),
      code_challenge_method: "S256",
    }).toString();
    const attempt = await bridge.begin({
      authorizationUrl: login.href,
      callbackPath: path,
      useState: true,
    });
    id = attempt.id;
    signal.addEventListener("abort", cancel, { once: true });
    signal.throwIfAborted();
    const response = await bridge.wait(id);
    signal.throwIfAborted();
    const parameters = new URLSearchParams(
      response.parameters.map(([name, value]) => [name, value]),
    );
    if (parameters.has("error"))
      throw new Error("Browser sign-in failed. Try again.");
    const codes = parameters.getAll("code");
    const code = codes[0];
    if (codes.length !== 1 || !code || code.length > 4096)
      throw new Error("Invalid Builderlab callback code.");
    const exchange = await request(
      host,
      target,
      "/v1/auth/login/exchange",
      signal,
      undefined,
      JSON.stringify({ code, code_verifier: verifier }),
    );
    const session_credential = exchange?.session_credential;
    if (
      typeof session_credential !== "string" ||
      !validCredentialValue(session_credential)
    )
      throw new Error("Builderlab did not return a valid credential.");
    return await verifyCredential(host, session_credential, signal, target);
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in canceled.");
    // Native errors are strings. Never forward provider bodies or credentials.
    throw error instanceof Error
      ? error
      : new Error("Could not complete Builderlab sign-in. Try again.");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (id) await bridge.cancel(id);
  }
}
