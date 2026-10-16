import { decode } from "nostr-tools/nip19";
import { enteredRelayOrigin } from "../communities/destination.ts";
import type { OwnedCommunity } from "./builderlab-account.ts";

/**
 * Development stand-in for the first-run Builderlab account reads, from
 * `BUZZ_DEV_FIRST_RUN_ACCOUNT`: `unlinked`, or
 * `{"npub": "npub1…", "communities": ["host", …]}`. Builds leave the Vite
 * define empty, so the seed can only ever answer a dev server. A leaf module
 * with explicit `.ts` imports: vite.config.ts validates the value through
 * Node's native loader.
 */
export type FirstRunAccountSeed = Readonly<{
  linked: string | null;
  communities: readonly OwnedCommunity[];
}>;

export function parseFirstRunAccountSeed(
  raw = "",
): FirstRunAccountSeed | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value === "unlinked") return { linked: null, communities: [] };
  try {
    const seed: unknown = JSON.parse(value);
    if (!seed || typeof seed !== "object" || Array.isArray(seed))
      throw new Error();
    const { npub, communities = [], ...rest } = seed as Record<string, unknown>;
    if (
      Object.keys(rest).length > 0 ||
      typeof npub !== "string" ||
      !Array.isArray(communities)
    )
      throw new Error();
    const decoded = decode(npub);
    if (decoded.type !== "npub") throw new Error();
    return {
      linked: decoded.data,
      communities: communities.map((host: unknown) => {
        if (typeof host !== "string") throw new Error();
        const url = enteredRelayOrigin(host);
        return { host: new URL(url).host, url };
      }),
    };
  } catch {
    // Do not echo malformed input: an environment value might contain credentials.
    throw new Error(
      "BUZZ_DEV_FIRST_RUN_ACCOUNT must be `unlinked` or a JSON object {npub, communities?: [hostname, …]}.",
    );
  }
}
