import { invoke } from "@tauri-apps/api/core";
import { communityDestination, relayAddress } from "./destination";
import { enqueue } from "./known-communities";
import type { Communities } from "./service";

const importedKey = (viewer: string) => `buzz-legacy-communities.v1:${viewer}`;

/** Adds the communities installed old Buzz saved to each viewer's list once,
 * through the same write a known-community list uses: saved without a
 * session, so no relay is contacted and one that is unreachable fails only
 * when opened, as any saved community does. Existing memberships stay as they
 * are; a relay already saved, not a secure origin, or whose removal is queued
 * is skipped, and each added one is queued for upload as a join would be. A
 * per-viewer marker, written once the list is saved, keeps a later removal
 * from being undone; a failed read or save leaves it unset so the next launch
 * tries again. */
export function importLegacyCommunities(
  communities: Pick<Communities, "snapshot" | "subscribe" | "applySync">,
  read = () => invoke<string[]>("legacy_communities"),
) {
  const attempted = new Set<string>();
  async function run() {
    const { status, viewer } = communities.snapshot();
    if (status !== "ready" || !viewer || attempted.has(viewer)) return;
    attempted.add(viewer);
    try {
      if (localStorage.getItem(importedKey(viewer)) !== null) return;
      const relays = await read();
      const current = communities.snapshot();
      if (current.status !== "ready" || current.viewer !== viewer) return;
      const removed = new Set(
        current.sync.outbox.filter((op) => op.removed).map((op) => op.url),
      );
      const saved = new Set(current.memberships.map((m) => m.id));
      let sync = current.sync;
      const add: string[] = [];
      for (const relay of relays) {
        let id: string;
        try {
          id = communityDestination(relay).id;
        } catch {
          continue;
        }
        const address = relayAddress(id);
        if (saved.has(id) || removed.has(address)) continue;
        saved.add(id);
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
  return unsubscribe;
}
