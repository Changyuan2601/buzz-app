import { decode } from "nostr-tools/nip19";
import { enteredRelayOrigin } from "../communities/destination.ts";
import {
  type BackupFailureKind,
  isBackupFailureKind,
} from "./backup-failure.ts";
import type { OwnedCommunity } from "./builderlab-account.ts";

/**
 * Development stand-in for the first-run Builderlab account, from
 * `BUZZ_DEV_FIRST_RUN_ACCOUNT`: `unlinked`, or
 * `{"npub"?: "npub1…", "communities"?: ["host", …], "backup"?: "<kind>"}`,
 * where no npub is an unlinked account and `backup` names the failure every
 * backup reports. Builds leave the Vite define empty, so the seed can only
 * ever answer a dev server. A leaf module with explicit `.ts` imports:
 * vite.config.ts validates the value through Node's native loader.
 */
export type FirstRunAccountSeed = Readonly<{
  linked: string | null;
  communities: readonly OwnedCommunity[];
  backup?: BackupFailureKind;
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
    const {
      npub,
      communities = [],
      backup,
      ...rest
    } = seed as Record<string, unknown>;
    if (
      Object.keys(rest).length > 0 ||
      (npub !== undefined && typeof npub !== "string") ||
      !Array.isArray(communities) ||
      (backup !== undefined && !isBackupFailureKind(backup))
    )
      throw new Error();
    const decoded = npub === undefined ? undefined : decode(npub);
    if (decoded && decoded.type !== "npub") throw new Error();
    return {
      linked: decoded ? decoded.data : null,
      communities: communities.map((host: unknown) => {
        if (typeof host !== "string") throw new Error();
        const url = enteredRelayOrigin(host);
        return { host: new URL(url).host, url };
      }),
      ...(backup === undefined ? {} : { backup }),
    };
  } catch {
    // Do not echo malformed input: an environment value might contain credentials.
    throw new Error(
      "BUZZ_DEV_FIRST_RUN_ACCOUNT must be `unlinked` or a JSON object {npub?, communities?: [hostname, …], backup?: failure kind}.",
    );
  }
}
