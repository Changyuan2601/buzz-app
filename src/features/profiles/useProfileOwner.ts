import { useEffect, useState, useSyncExternalStore } from "react";
import { attestedOwner } from "../agents/owner-attestation";
import type { Profile } from "../relay/contracts";
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";

const noSubscribe = () => () => {};
const none = () => undefined;
// One verification per retained signed head, shared by every row that shows it.
const checks = new WeakMap<RelayEvent, Promise<string | undefined>>();
const results = new WeakMap<RelayEvent, { owner: string | undefined }>();

function verify(head: RelayEvent) {
  let check = checks.get(head);
  if (!check) {
    check = attestedOwner(head).then((owner) => {
      results.set(head, { owner });
      return owner;
    });
    checks.set(head, check);
  }
  return check;
}

/** Verified NIP-OA owner of the profile head the session already retains, for
 * display only, never authorization. Reads no agent profile: the profile pane
 * owns live evidence (`useAgentOwnerEvidence`). Reads the owner's profile from
 * the session directory, since row-selected profiles do not include owners. */
export function useProfileOwner(
  session: RelaySession | undefined,
  pubkey: string | undefined,
): { id: string; profile: Profile | undefined } | undefined {
  const profiles = pubkey ? session?.profiles : undefined;
  const head = useSyncExternalStore(
    profiles?.subscribe ?? noSubscribe,
    profiles?.event && pubkey ? () => profiles.event?.(pubkey) : none,
    profiles?.event && pubkey ? () => profiles.event?.(pubkey) : none,
  );
  const [, settled] = useState<RelayEvent>();
  useEffect(() => {
    if (!head || results.has(head)) return;
    let active = true;
    void verify(head).then(() => {
      if (active) settled(head);
    });
    return () => {
      active = false;
    };
  }, [head]);
  const owner = head ? results.get(head)?.owner : undefined;
  useEffect(() => {
    if (owner) void profiles?.ensure([owner], "background").catch(() => {});
  }, [profiles, owner]);
  const profile = useSyncExternalStore(
    owner && profiles ? profiles.subscribe : noSubscribe,
    owner && profiles ? () => profiles.snapshot().get(owner) : none,
    owner && profiles ? () => profiles.snapshot().get(owner) : none,
  );
  return owner ? { id: owner, profile } : undefined;
}
