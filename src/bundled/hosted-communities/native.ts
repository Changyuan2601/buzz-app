// Packaged-desktop Builderlab account backend, mirroring browser-host/builderlab.mjs route for
// route. The session credential lives only in this plugin's memory; native code owns
// the browser callback, host HTTP, and the kind 24243 binding signature.
import { invoke } from "@tauri-apps/api/core";
import type { Host, HostRequest } from "../../features/host/service";
import { boundKey, type Account, type Backend } from "./api";

export const BUILDERLAB_ORIGIN = "https://app.builderlab.xyz";
const API = `${BUILDERLAB_ORIGIN}/api/goose`;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Account routes forwarded with allowlisted string fields only. */
const ROUTES: Record<string, readonly [string, readonly string[]]> = {
  identity: ["/v1/buzz/nostr-identities/current", []],
  unbind: ["/v1/buzz/nostr-identities/delete", []],
  list: ["/v1/buzz/communities/list", []],
  availability: ["/v1/buzz/communities/availability", ["name"]],
  create: ["/v1/buzz/communities", ["name"]],
  archive: ["/v1/buzz/communities/archive", ["community_id"]],
  unarchive: ["/v1/buzz/communities/unarchive", ["community_id"]],
  delete: [
    "/v1/buzz/communities/delete",
    ["community_id", "host", "request_id", "acknowledgement_version"],
  ],
  // Builderlab's transfer endpoint takes camelCase keys.
  transfer: [
    "/v1/buzz/communities/transfer",
    ["communityId", "transfereeNpub"],
  ],
};

type Native = Readonly<{
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}>;
const native: Native = { invoke };

/** Native commands and host HTTP reject with strings; surface them as errors. */
const asError = (error: unknown) =>
  typeof error === "string" ? new Error(error) : error;
const command = <T>(
  bridge: Native,
  name: string,
  args?: Record<string, unknown>,
) =>
  bridge.invoke<T>(name, args).catch((error: unknown) => {
    throw asError(error);
  });

/** Waits for one loopback redirect carrying `code`, through the native listener. */
async function awaitCode(bridge: Native, signal: AbortSignal) {
  signal.throwIfAborted();
  const login = new URL(`${API}/v1/auth/login`);
  login.search = new URLSearchParams({
    type: "cli",
    product: "buzz",
  }).toString();
  const { id } = await command<{ id: string }>(bridge, "oauth_callback_begin", {
    authorizationUrl: login.href,
    callbackPath: `/callback/${crypto.randomUUID().replaceAll("-", "")}`,
  });
  const cancel = () =>
    void bridge.invoke("oauth_callback_cancel", { id }).catch(() => {});
  try {
    signal.throwIfAborted();
    signal.addEventListener("abort", cancel, { once: true });
    const { parameters } = await command<{
      parameters: readonly (readonly [string, string])[];
    }>(bridge, "oauth_callback_wait", { id });
    signal.throwIfAborted();
    const query = new URLSearchParams(parameters.map(([k, v]) => [k, v]));
    const code = query.get("code");
    if (!code)
      throw new Error(
        query.get("error_description") ??
          query.get("error") ??
          "Authentication callback did not include a code",
      );
    return code;
  } catch (error) {
    if (signal.aborted) throw new Error("Builderlab authentication canceled");
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export function createNativeBackend(host: Host, bridge: Native = native) {
  const http = (input: HostRequest) =>
    host.request(input).catch((error: unknown) => {
      throw asError(error);
    });
  const parse = (body: string) => {
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES)
      throw new Error("Builderlab response was too large");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("Builderlab returned an invalid response");
    }
  };
  let credential: string | undefined;
  const request = async (
    path: string,
    body: object,
    session = credential,
  ): Promise<{ status: number; value: object }> => {
    if (!session) throw new Error("Sign in to Builderlab first");
    const response = await http({
      url: `${API}${path}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-Session-Credential": session,
        Origin: BUILDERLAB_ORIGIN,
      },
      body: JSON.stringify(body),
    });
    const value = parse(response.body);
    const ok = response.status >= 200 && response.status < 300;
    // Structured `{ error: { code, ... } }` bodies pass through for friendly UI messages.
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (ok || (value as { error?: unknown }).error)
    )
      return { status: response.status, value };
    throw new Error(`Builderlab request failed (HTTP ${response.status}).`);
  };
  const me = async (session: string, signal: AbortSignal): Promise<Account> => {
    const response = await http({
      url: `${API}/v1/auth/me`,
      headers: { "X-BB-Session-Credential": session },
    });
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        `Builderlab session check failed with HTTP ${response.status}`,
      );
    const { email, name, expires_at, capabilities } = (parse(response.body) ??
      {}) as {
      email?: unknown;
      name?: unknown;
      expires_at?: unknown;
      capabilities?: { can_delete_buzz_communities?: unknown };
    };
    if (typeof expires_at !== "string")
      throw new Error("Builderlab returned an invalid response");
    return {
      ...(typeof email === "string" ? { email } : {}),
      ...(typeof name === "string" ? { name } : {}),
      expiresAt: expires_at,
      capabilities: {
        can_delete_buzz_communities:
          capabilities?.can_delete_buzz_communities === true,
      },
    };
  };
  // Sign-in and sign-out bump the generation; late results from an older one never
  // write, clear or describe the current session.
  let generation = 0;
  let session = new AbortController();
  const revoke = () => {
    generation += 1;
    session.abort();
    session = new AbortController();
    credential = undefined;
  };
  const login = async (signal: AbortSignal) => {
    revoke();
    const started = generation;
    const attempt = AbortSignal.any([signal, session.signal]);
    const code = await awaitCode(bridge, attempt);
    const response = await http({
      url: `${API}/v1/auth/login/exchange`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    attempt.throwIfAborted();
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        `Builderlab code exchange failed with HTTP ${response.status}`,
      );
    const exchanged = (parse(response.body) ?? {}) as {
      session_credential?: unknown;
      expires_at?: unknown;
    };
    if (
      typeof exchanged.session_credential !== "string" ||
      !exchanged.session_credential
    )
      throw new Error("Builderlab code exchange returned an empty credential");
    const account = await me(exchanged.session_credential, attempt);
    if (account.expiresAt !== exchanged.expires_at)
      throw new Error("Builderlab session expiry did not match code exchange");
    if (attempt.aborted || started !== generation)
      throw new Error("Builderlab authentication canceled");
    credential = exchanged.session_credential;
    return account;
  };
  const bind = async () => {
    const current = credential;
    const started = generation;
    const challenge = await request(
      "/v1/buzz/nostr-identities/challenge",
      { origin: BUILDERLAB_ORIGIN },
      current,
    );
    if ((challenge.value as { error?: unknown }).error) return challenge;
    // A sign-out, new sign-in or disposal while the challenge or native signature
    // is pending must not let the old credential claim this device's key.
    const ensureCurrent = () => {
      if (started !== generation) throw new Error("Builderlab session changed");
    };
    ensureCurrent();
    const { challenge_id, nonce, verification_code, origin, expires_at } =
      challenge.value as Record<string, unknown>;
    const event = await command<object>(
      bridge,
      "identity_sign_builderlab_binding",
      {
        challenge: {
          challenge_id,
          nonce,
          verification_code,
          origin,
          expires_at,
        },
      },
    );
    ensureCurrent();
    return request(
      "/v1/buzz/nostr-identities/verify",
      { challenge_id, nonce, signed_payload: JSON.stringify(event) },
      current,
    );
  };
  const call = (action: string, input?: Record<string, unknown>) => {
    const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : undefined;
    if (!route) throw new Error("Unknown Builderlab route");
    const [path, fields] = route;
    const body: Record<string, string | number> = {};
    for (const field of fields) {
      const value = input?.[field];
      if (field === "acknowledgement_version") {
        if (!Number.isInteger(value)) throw new Error(`Missing ${field}`);
        body[field] = value as number;
        continue;
      }
      if (typeof value !== "string" || !value || value.length > 253)
        throw new Error(`Missing ${field}`);
      body[field] = value;
    }
    return request(path, body);
  };
  const backend: Backend = {
    origin: BUILDERLAB_ORIGIN,
    async auth() {
      const current = credential;
      if (!current) return null;
      const started = generation;
      try {
        const account = await me(current, session.signal);
        if (started !== generation)
          throw new Error("Builderlab session changed");
        return account;
      } catch (error) {
        if (started === generation) credential = undefined;
        throw error;
      }
    },
    async send(action, body, signal) {
      if (action === "login")
        return {
          status: 200,
          value: { auth: await login(signal ?? session.signal) },
        };
      if (action === "sign-out") {
        revoke();
        return { status: 200, value: {} };
      }
      if (action === "bind") return bind();
      return call(action, body);
    },
    async localKey() {
      try {
        const viewer = await command<string | null>(bridge, "identity_restore");
        return boundKey(viewer ? { pubkey_hex: viewer } : null);
      } catch {
        return null;
      }
    },
  };
  return { backend, dispose: revoke };
}
