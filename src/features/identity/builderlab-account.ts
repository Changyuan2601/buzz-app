import { invoke } from "@tauri-apps/api/core";
import {
  type Credential,
  oauthTarget,
} from "../../bundled/builderlab/oauth/browser";
import {
  boundKey,
  check,
  relayUrl,
  type Reply,
} from "../../bundled/hosted-communities/api";
import { enteredRelayOrigin } from "../communities/destination";
import type { Host, HostResponse } from "../host/service";
import { BackupError, backUpWith } from "./backup";
import type { FirstRunAccountSeed } from "./first-run-seed";
import type { Identity } from "./service";

/** A community the signed-in account owns: its hostname and the canonical origin a join uses. */
export type OwnedCommunity = Readonly<{ host: string; url: string }>;

/**
 * What first run reads about the signed-in Builderlab account, the binding
 * that makes this device's key the account's, and that key's backup. Unlinking
 * stays the `[TODO]` step in setup.ts.
 */
export type FirstRunAccount = Readonly<{
  /** The hex key bound 1:1 to the account, or null when none is (a reply with no `identity`). */
  linkedKey(): Promise<string | null>;
  /** The communities the account owns. Archived ones have no relay to join and are left out. */
  ownedCommunities(): Promise<readonly OwnedCommunity[]>;
  /**
   * Binds `pubkey`, the key on this device, to the account: kgoose's challenge,
   * the native kind-24243 signer, then verify. Sends nothing more once the
   * account already holds that key, so running it again is safe.
   */
  bind(pubkey: string): Promise<void>;
  /**
   * Whether this build can back a key up for this sign-in: native backup runs
   * only for the build's own Builderlab portal. Any error answers false.
   */
  backupOffered(): Promise<boolean>;
  /** Backs `pubkey` up and waits for the native uploader's result; rejects with a `BackupError`. */
  backUp(pubkey: string): Promise<void>;
  /** Turns automatic backup off for `pubkey`. Best effort: never rejects. */
  declineBackup(pubkey: string): Promise<void>;
}>;

/** The identity's backup status and consent, which the backup steps use. */
type BackupIdentity = Pick<Identity, "backup" | "setBackupChoice">;

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Native commands and host HTTP reject with strings; surface them as errors. */
const asError = (error: unknown) =>
  typeof error === "string" ? new Error(error) : error;

/**
 * A setup-needed mapping is "not linked", as the hosted-communities card reads
 * it. Only the list route answers this way; the identity route answers 200
 * with no `identity` instead (see `linkedKey`).
 */
const notLinked = (reply: Reply) =>
  reply.error?.setup_needed === true ||
  (typeof reply.error?.code === "string" &&
    reply.error.code.toLowerCase() === "missing_mapping");

/**
 * Names the step and the HTTP status so a failed page tells the account check
 * from the list, and a 403 text/plain from a JSON shape problem. Never the
 * response body: provider bodies are not forwarded to the user.
 */
const failure = (step: string, response: HostResponse, detail?: string) =>
  new Error(
    `Builderlab ${step} failed (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`,
  );

/** The hosted-communities native backend's reply rules, for a response that came through the bundled grant. */
function parse(step: string, response: HostResponse): Reply {
  if (new TextEncoder().encode(response.body).byteLength > MAX_RESPONSE_BYTES)
    throw failure(step, response, "response too large");
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw failure(step, response, "not JSON");
  }
  const ok = response.status >= 200 && response.status < 300;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (ok || (value as Reply).error)
  )
    return value as Reply;
  throw failure(step, response);
}

function owned(community: NonNullable<Reply["communities"]>[number]) {
  const relay = relayUrl(community);
  if (!relay || community.archived_at) return [];
  try {
    const url = enteredRelayOrigin(relay);
    return [{ host: new URL(url).host, url }];
  } catch {
    return [];
  }
}

/**
 * Whether this build backs a key up for a Builderlab sign-in at `origin` (the
 * build's own portal when omitted, where Settings signs in). The uploader
 * accepts credentials only from that portal, so a tenant's status is never
 * read, and runs only when the status says Builderlab backup is allowed. First
 * run and Settings → Identity share this rule. Any error answers false.
 */
export async function backupOfferedFor(
  backup: Pick<Identity["backup"], "ready">,
  origin?: string,
) {
  try {
    if (new URL(oauthTarget(origin)).origin !== new URL(oauthTarget()).origin)
      return false;
    return (await backup.ready()).builderlab;
  } catch {
    return false;
  }
}

/**
 * The real reads and binding, against the kgoose sign-in used
 * (`<origin>/api/goose`; the build URL when no tenant was chosen),
 * authenticated with the first-run session credential and sent through the
 * bundled plugin's native grant like the sign-in itself. Routes and reply
 * shapes are the hosted-communities card's (`native.ts` ROUTES `identity` and
 * `list` and its `bind`; `api.ts` parsers); the card's own backend is not
 * touched. The backup goes through the native uploader instead (`backup.ts`).
 */
export function builderlabAccount(
  credential: Credential,
  origin: string | undefined,
  request: Host["request"],
  identity: BackupIdentity,
): FirstRunAccount {
  const target = oauthTarget(origin);
  const portal = new URL(target).origin;
  /**
   * One POST; `read` turns the parsed reply (null when not linked) into the
   * answer. Any refusal of the answer is logged in development with the
   * route and status — again never the body — then thrown.
   */
  const call = async <T>(
    step: string,
    path: string,
    fallback: string,
    read: (reply: Reply | null, response: HostResponse) => T,
    body: object = {},
  ) => {
    const response = await request({
      url: `${target}${path}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-Session-Credential": credential.value,
        // Binding requires the challenge origin to match this header.
        Origin: portal,
      },
      body: JSON.stringify(body),
    }).catch((error: unknown) => {
      throw asError(error);
    });
    try {
      const reply = parse(step, response);
      return read(notLinked(reply) ? null : check(reply, fallback), response);
    } catch (error) {
      if (import.meta.env.DEV)
        console.warn(
          `Builderlab ${step}: POST ${path} answered HTTP ${response.status}`,
          error instanceof Error ? error.message : error,
        );
      throw error;
    }
  };
  const linkedKey = () =>
    call(
      "account check",
      "/v1/buzz/nostr-identities/current",
      "Could not check this Builderlab account.",
      (reply, response) => {
        // kgoose answers 200 with `identity` null or absent when no key is
        // bound; it never sends MISSING_MAPPING here. A linked account must
        // never be given a second key, so a bound identity without a usable
        // key is a failure, not "not linked".
        if (!reply || reply.identity == null) return null;
        const key = boundKey(reply.identity);
        if (!key)
          throw failure("account check", response, "unusable linked key");
        return key;
      },
    );
  return {
    linkedKey,
    async bind(pubkey) {
      // Re-running after a failure must not meet 409 `pubkey_already_bound`.
      if ((await linkedKey()) === pubkey) return;
      const step = "account link";
      const fallback = "Could not link your key to this Builderlab account.";
      // A challenge for another bound key answers 409 `identity_already_bound`.
      const challenge = await call(
        step,
        "/v1/buzz/nostr-identities/challenge",
        fallback,
        (reply, response) => {
          if (!reply) throw failure(step, response);
          const { challenge_id, nonce, verification_code, origin, expires_at } =
            reply as Record<string, unknown>;
          return { challenge_id, nonce, verification_code, origin, expires_at };
        },
        { origin: portal },
      );
      // Native code signs only a well-formed challenge for a granted origin.
      const event = await invoke<object>("identity_sign_builderlab_binding", {
        challenge,
      }).catch((error: unknown) => {
        throw asError(error);
      });
      await call(
        step,
        "/v1/buzz/nostr-identities/verify",
        fallback,
        (reply, response) => {
          if (boundKey(reply?.identity) !== pubkey)
            throw failure(step, response, "link not confirmed");
        },
        {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          signed_payload: JSON.stringify(event),
        },
      );
    },
    ownedCommunities: () =>
      call(
        "community list",
        "/v1/buzz/communities/list",
        "Could not load the communities this account owns.",
        (reply) => reply?.communities?.flatMap(owned) ?? [],
      ),
    backupOffered: () => backupOfferedFor(identity.backup, origin),
    backUp: (pubkey) => backUpWith(identity, pubkey, credential.value),
    declineBackup: (pubkey) =>
      identity.setBackupChoice(pubkey, false).then(
        () => {},
        (error: unknown) => {
          // Consent stays on; Settings → Identity still shows the key.
          if (import.meta.env.DEV)
            console.warn("Could not turn automatic backup off", error);
        },
      ),
  };
}

/**
 * The reads answered from the `BUZZ_DEV_FIRST_RUN_ACCOUNT` development seed.
 * Binding and backup succeed without a request, a native signature or a
 * native backup command, and backup is offered in every build; a seeded
 * `backup` kind fails every backup with that kind's page instead.
 */
export const seededAccount = (seed: FirstRunAccountSeed): FirstRunAccount => ({
  linkedKey: () => Promise.resolve(seed.linked),
  ownedCommunities: () => Promise.resolve(seed.communities),
  bind: () => Promise.resolve(),
  backupOffered: () => Promise.resolve(true),
  backUp: () =>
    seed.backup
      ? Promise.reject(new BackupError(seed.backup))
      : Promise.resolve(),
  declineBackup: () => Promise.resolve(),
});
