import { invoke } from "@tauri-apps/api/core";
import { communityDestination, relayAddress } from "./destination";
import { enqueue } from "./known-communities";
import type { Communities } from "./service";

/** A community installed old Buzz saved, and the identity it saved it for. */
export type LegacyCommunity = { relayUrl: string; pubkey?: string };

const importedKey = (viewer: string) => `buzz-legacy-communities.v1:${viewer}`;

/** Adds the communities installed old Buzz saved to its identity's list once,
 * through the same write a known-community list uses: saved without a
 * session or join, so a relay that is unreachable fails only when opened, as
 * any saved community does. Only the communities old Buzz recorded for this
 * viewer's identity are taken; one saved for another identity, or that
 * records none, is not. Existing memberships stay as they are; a relay
 * already saved, saved at any point while this ran, not a secure origin, or
 * whose removal is queued is skipped, and each added one is queued for upload
 * as a join would be. A per-viewer marker, written once the list is saved,
 * keeps a later removal from being undone; a failed read or save leaves it
 * unset so the next launch tries again. The returned disposer also abandons a
 * read still in flight. */
export function importLegacyCommunities(
  communities: Pick<Communities, "snapshot" | "subscribe" | "applySync">,
  read = () => invoke<LegacyCommunity[]>("legacy_communities"),
) {
  let disposed = false;
  const attempted = new Set<string>();
  // Every membership each viewer held since this started, so one left while
  // the read was pending stays gone once its removal is acknowledged.
  const seen = new Map<string, Set<string>>();
  function observe() {
    const { viewer, memberships } = communities.snapshot();
    if (!viewer) return new Set<string>();
    const ids = seen.get(viewer) ?? new Set<string>();
    seen.set(viewer, ids);
    for (const { id } of memberships) ids.add(id);
    return ids;
  }
  async function run() {
    observe();
    const { status, viewer } = communities.snapshot();
    if (disposed || status !== "ready" || !viewer || attempted.has(viewer))
      return;
    attempted.add(viewer);
    try {
      if (localStorage.getItem(importedKey(viewer)) !== null) return;
      const saved = await read();
      const current = communities.snapshot();
      if (disposed || current.status !== "ready" || current.viewer !== viewer)
        return;
      const held = observe();
      const removed = new Set(
        current.sync.outbox.filter((op) => op.removed).map((op) => op.url),
      );
      const add: string[] = [];
      let sync = current.sync;
      for (const { relayUrl, pubkey } of saved) {
        if (pubkey !== viewer) continue;
        let id: string;
        try {
          id = communityDestination(relayUrl).id;
        } catch {
          continue;
        }
        const address = relayAddress(id);
        if (held.has(id) || removed.has(address)) continue;
        held.add(id);
        add.push(id);
        sync = enqueue(sync, address, false);
      }
      if (add.length) await communities.applySync(sync, add);
      localStorage.setItem(importedKey(viewer), "1");
    } catch (error) {
      console.warn("Couldn't add old Buzz's communities", error);
    }
  }
  const unsubscribe = communities.subscribe(() => void run());
  void run();
  return () => {
    disposed = true;
    unsubscribe();
  };
}
