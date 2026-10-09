import { nativeRelayRequest } from "../relay/native";
import { communityIcon } from "./community-icon";
import { joinPolicy, type JoinPolicy } from "./join-policy";

/** Only what a relay publishes before admission: no name, owner or member count. */
export type FoundCommunity = {
  /** Canonical secure origin. */
  url: string;
  host: string;
  icon?: string | undefined;
  policy: JoinPolicy | null;
  /** The viewer's key is already admitted; false when unknown or no key was given. */
  member: boolean;
};

export type FindFailure = "unreachable" | "not-buzz" | "no-community";

export class FindCommunityError extends Error {
  constructor(readonly failure: FindFailure) {
    super(failure);
  }
}

export type RelayFetch = (
  origin: string,
  path: string,
  signal: AbortSignal,
  /** A body makes it a NIP-98-signed POST under the device's human key. */
  body?: unknown,
) => Promise<Response>;

/** `relay_http`: unauthenticated GETs, or a POST signed by the native identity owner. */
export const nativeRelayFetch: RelayFetch = (origin, path, signal, body) =>
  nativeRelayRequest(origin, path, body, signal);

const BUZZ_SOFTWARE = "https://github.com/block/buzz";

/**
 * NIP-11 and the join policy in parallel; the NIP-11 verdict is reported first.
 * A policy 404 means "none" only once NIP-11 has confirmed a Buzz relay; any
 * other non-answer is retryable rather than a silent waiver of consent. With a
 * `viewer`, a Buzz relay is also asked whether that key is already a member.
 */
export async function findCommunity(
  url: string,
  request: RelayFetch,
  signal: AbortSignal,
  viewer?: string,
): Promise<FoundCommunity> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const get = (path: string) =>
    request(url, path, bounded).catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new FindCommunityError("unreachable");
    });
  const discovery = get("/");
  const policy = get("/api/join-policy");
  policy.catch(() => {});
  const info = await relayInfo(await discovery);
  // Signed only after NIP-11 vouches for the host: the key goes to no stranger.
  const [answer, member] = await Promise.all([
    policy.then(policyAnswer),
    viewer ? isMember(url, request, bounded, viewer) : false,
  ]);
  return {
    url,
    host: new URL(url).host,
    icon: communityIcon(info.icon),
    policy: answer,
    member,
  };
}

/**
 * The relay publishes no unauthenticated membership signal; the only answer is
 * what a NIP-98-signed `POST /query` returns, as `inspectProfile` relies on: a
 * denial means not a member, a successful read means admitted. Any other
 * outcome (network, 5xx) is unknown, never membership. On a relay that does not
 * enforce membership every key looks admitted.
 */
async function isMember(
  url: string,
  request: RelayFetch,
  signal: AbortSignal,
  viewer: string,
) {
  try {
    const response = await request(url, "/query", signal, [
      { kinds: [0], authors: [viewer], limit: 1 },
    ]);
    return response.ok;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

async function policyAnswer(response: Response) {
  if (response.status === 404) return null;
  try {
    const body: unknown = response.ok ? await response.json() : undefined;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return joinPolicy(body as Record<string, unknown>);
  } catch {
    throw new FindCommunityError("unreachable");
  }
}

async function relayInfo(response: Response) {
  if (response.status >= 500) throw new FindCommunityError("unreachable");
  const body: unknown = response.ok
    ? await response.json().catch(() => undefined)
    : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new FindCommunityError("not-buzz");
  const info = body as Record<string, unknown>;
  // buzz-relay nip11.rs hard-codes both; either identifies the software.
  if (
    info.name !== "Buzz Relay" &&
    !(
      typeof info.software === "string" &&
      info.software.startsWith(BUZZ_SOFTWARE)
    )
  )
    throw new FindCommunityError("not-buzz");
  // Host-bound fields are present only when the relay maps this host to a community.
  if (
    info.read_state_snapshot === undefined &&
    info.icon === undefined &&
    info.buzz_v1 === undefined
  )
    throw new FindCommunityError("no-community");
  return info;
}
