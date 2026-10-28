import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { Presence, PresenceStatus } from "./presence";

const unknown = "unknown:false";
function usePresenceState(
  presence: Presence | undefined,
  pubkey: string | undefined,
  profile = false,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      presence && pubkey
        ? presence.subscribe(pubkey, listener, profile)
        : () => {},
    [presence, pubkey, profile],
  );
  const snapshot = useCallback(
    () =>
      presence && pubkey
        ? `${presence.status(pubkey)}:${presence.limited(pubkey)}`
        : unknown,
    [presence, pubkey],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function usePresenceStatus(
  presence: Presence | undefined,
  pubkey: string | undefined,
  profile = false,
): PresenceStatus {
  return usePresenceState(presence, pubkey, profile).split(
    ":",
  )[0] as PresenceStatus;
}

/** Reads presence below a larger component, so a change re-renders only the
 * part that shows it. */
export function PresenceStatusScope({
  presence,
  pubkey,
  children,
}: {
  presence: Presence | undefined;
  pubkey: string | undefined;
  children(status: PresenceStatus): ReactNode;
}) {
  return children(usePresenceStatus(presence, pubkey));
}

/** Text and distinct symbols keep presence readable without color perception. */
export function PresenceIndicator({
  presence,
  pubkey,
  profile = false,
}: {
  presence: Presence;
  pubkey: string;
  profile?: boolean;
}) {
  const state = usePresenceState(presence, pubkey, profile);
  const status = state.split(":")[0] as ReturnType<Presence["status"]>;
  // Missing or stale evidence is not proof that someone is offline.
  if (status === "unknown") return null;
  const label = {
    online: "Active",
    away: "Away",
    offline: "Offline",
  }[status];
  const symbol = { online: "●", away: "◐", offline: "○" }[status];
  return (
    <span
      role="img"
      className="text-body-sm text-secondary"
      aria-label={`Presence: ${label}`}
      title={
        presence.limited(pubkey)
          ? "Presence demand limit reached"
          : "Recent Buzz session status in this community; periodically refreshed"
      }
    >
      {symbol} {label}
    </span>
  );
}
