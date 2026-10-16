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
import type { FirstRunAccountSeed } from "./first-run-seed";

/** A community the signed-in account owns: its hostname and the canonical origin a join uses. */
export type OwnedCommunity = Readonly<{ host: string; url: string }>;

/**
 * What first run reads about the signed-in Builderlab account. Both are reads;
 * binding, backup and unlinking stay the `[TODO]` steps in setup.ts.
 */
export type FirstRunAccount = Readonly<{
  /** The hex key bound 1:1 to the account, or null when none is (a reply with no `identity`). */
  linkedKey(): Promise<string | null>;
  /** The communities the account owns. Archived ones have no relay to join and are left out. */
  ownedCommunities(): Promise<readonly OwnedCommunity[]>;
}>;

const MAX_RESPONSE_BYTES = 64 * 1024;

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
 * The real reads, against the kgoose sign-in used (`<origin>/api/goose`; the
 * build URL when no tenant was chosen), authenticated with the first-run
 * session credential and sent through the bundled plugin's native grant like
 * the sign-in itself. Routes and reply shapes are the hosted-communities
 * card's (`native.ts` ROUTES `identity` and `list`; `api.ts` parsers); the
 * card's own backend is not touched.
 */
export function builderlabAccount(
  credential: Credential,
  origin: string | undefined,
  request: Host["request"],
): FirstRunAccount {
  const target = oauthTarget(origin);
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
  ) => {
    const response = await request({
      url: `${target}${path}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-Session-Credential": credential.value,
        Origin: new URL(target).origin,
      },
      body: "{}",
    }).catch((error: unknown) => {
      throw typeof error === "string" ? new Error(error) : error;
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
  return {
    linkedKey: () =>
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
      ),
    ownedCommunities: () =>
      call(
        "community list",
        "/v1/buzz/communities/list",
        "Could not load the communities this account owns.",
        (reply) => reply?.communities?.flatMap(owned) ?? [],
      ),
  };
}

/** Both reads answered from the `BUZZ_DEV_FIRST_RUN_ACCOUNT` development seed. */
export const seededAccount = (seed: FirstRunAccountSeed): FirstRunAccount => ({
  linkedKey: () => Promise.resolve(seed.linked),
  ownedCommunities: () => Promise.resolve(seed.communities),
});
