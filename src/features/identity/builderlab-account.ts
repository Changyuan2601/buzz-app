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
  /** The hex key bound 1:1 to the account, or null when none is (`MISSING_MAPPING`). */
  linkedKey(): Promise<string | null>;
  /** The communities the account owns. Archived ones have no relay to join and are left out. */
  ownedCommunities(): Promise<readonly OwnedCommunity[]>;
}>;

const MAX_RESPONSE_BYTES = 64 * 1024;

/** A setup-needed mapping is "not linked", as the hosted-communities card reads it. */
const notLinked = (reply: Reply) =>
  reply.error?.setup_needed === true ||
  reply.error?.code?.toLowerCase() === "missing_mapping";

/** The hosted-communities native backend's reply rules, for a response that came through the bundled grant. */
function parse(response: HostResponse): Reply {
  if (new TextEncoder().encode(response.body).byteLength > MAX_RESPONSE_BYTES)
    throw new Error("Builderlab response was too large");
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw new Error("Builderlab returned an invalid response");
  }
  const ok = response.status >= 200 && response.status < 300;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (ok || (value as Reply).error)
  )
    return value as Reply;
  throw new Error(`Builderlab request failed (HTTP ${response.status}).`);
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
  const call = async (path: string, fallback: string) => {
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
    const reply = parse(response);
    return notLinked(reply) ? null : check(reply, fallback);
  };
  return {
    async linkedKey() {
      const reply = await call(
        "/v1/buzz/nostr-identities/current",
        "Could not check this Builderlab account.",
      );
      if (!reply) return null;
      // A linked account must never be given a second key, so a bound identity
      // without a usable key is a failure, not "not linked".
      const key = boundKey(reply.identity);
      if (!key) throw new Error("Builderlab returned an invalid response");
      return key;
    },
    async ownedCommunities() {
      const reply = await call(
        "/v1/buzz/communities/list",
        "Could not load the communities this account owns.",
      );
      return reply?.communities?.flatMap(owned) ?? [];
    },
  };
}

/** Both reads answered from the `BUZZ_DEV_FIRST_RUN_ACCOUNT` development seed. */
export const seededAccount = (seed: FirstRunAccountSeed): FirstRunAccount => ({
  linkedKey: () => Promise.resolve(seed.linked),
  ownedCommunities: () => Promise.resolve(seed.communities),
});
