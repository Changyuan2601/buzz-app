// Native account operations share the host-owned FI session. No credential enters this plugin.
import { invoke } from "@tauri-apps/api/core";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { boundKey, type Account, type Backend } from "./api";

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

export function createNativeBackend(identity: FederatedIdentity) {
  const configured = () => {
    const snapshot = identity.snapshot();
    if (!snapshot.authority)
      throw new Error("Federated identity is not configured");
    return { ...snapshot, authority: snapshot.authority };
  };
  const request = async (route: string, body: object, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const snapshot = configured();
    if (snapshot.status !== "signed-in")
      throw new Error("Sign in to Builderlab first");
    const response = await identity.request({
      path: `${snapshot.authority.apiBasePath}${route.replace(/^\//, "")}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    signal?.throwIfAborted();
    if (identity.snapshot().revision !== snapshot.revision)
      throw new Error("Federated session changed");
    if (new TextEncoder().encode(response.body).byteLength > 64 * 1024)
      throw new Error("Builderlab response was too large");
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new Error("Builderlab returned an invalid response");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (response.status >= 400 && !("error" in value))
    )
      throw new Error(`Builderlab request failed (HTTP ${response.status}).`);
    return { status: response.status, value };
  };
  const auth = (): Account | null => {
    const snapshot = identity.snapshot();
    if (snapshot.status !== "signed-in") return null;
    return { ...(snapshot.email ? { email: snapshot.email } : {}) };
  };
  const backend: Backend = {
    get origin() {
      return configured().authority.identityOrigin;
    },
    async auth() {
      return auth();
    },
    async localKey() {
      try {
        const viewer = await invoke<string | null>("identity_restore");
        return boundKey(viewer ? { pubkey_hex: viewer } : null);
      } catch {
        return null;
      }
    },
    async send(action, input, signal) {
      signal?.throwIfAborted();
      if (action === "login") {
        // Abort stops only a login still running; it never ends a finished one.
        const cancel = () => {
          if (identity.snapshot().status === "signing-in")
            void identity.cancelSignIn().catch(() => {});
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          await identity.signIn();
          signal?.throwIfAborted();
          return { status: 200, value: { auth: auth() } };
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      }
      if (action === "sign-out") {
        await identity.signOut();
        return { status: 200, value: {} };
      }
      if (action === "bind") {
        const revision = configured().revision;
        const challenge = await request(
          "/v1/buzz/nostr-identities/challenge",
          { origin: backend.origin },
          signal,
        );
        if ((challenge.value as { error?: unknown }).error) return challenge;
        signal?.throwIfAborted();
        if (identity.snapshot().revision !== revision)
          throw new Error("Federated session changed");
        const { challenge_id, nonce, verification_code, origin, expires_at } =
          challenge.value as Record<string, unknown>;
        const event = await invoke<object>("identity_sign_builderlab_binding", {
          challenge: {
            challenge_id,
            nonce,
            verification_code,
            origin,
            expires_at,
          },
        }).catch((error: unknown) => {
          throw typeof error === "string" ? new Error(error) : error;
        });
        signal?.throwIfAborted();
        if (identity.snapshot().revision !== revision)
          throw new Error("Federated session changed");
        const verified = await request(
          "/v1/buzz/nostr-identities/verify",
          { challenge_id, nonce, signed_payload: JSON.stringify(event) },
          signal,
        );
        if (
          verified.status < 300 &&
          !(verified.value as { error?: unknown }).error
        )
          void invoke("nsec_backup_retry", { source: "hosted" }).catch(
            () => {},
          );
        return verified;
      }
      const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : undefined;
      if (!route) throw new Error("Unknown Builderlab route");
      const [path, fields] = route;
      const body: Record<string, string | number> = {};
      for (const field of fields) {
        const value = input?.[field];
        if (field === "acknowledgement_version") {
          if (!Number.isInteger(value)) throw new Error(`Missing ${field}`);
          body[field] = value as number;
        } else {
          if (typeof value !== "string" || !value || value.length > 253)
            throw new Error(`Missing ${field}`);
          body[field] = value;
        }
      }
      return request(path, body, signal);
    },
  };
  return { backend };
}
