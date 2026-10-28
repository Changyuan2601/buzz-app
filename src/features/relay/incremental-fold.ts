import type { ChannelMessage } from "./contracts";
import type { EventData } from "./events";
import { collapseHuddleCards, foldMessages } from "./fold";
import { channelRowKind } from "./membership";
import { compareMessages } from "./message-order";

/** `foldMessages` for one view's changing evidence: each row refolds only when
 * its event, its overlays (and their overlays) or a consulted agent owner change.
 * Stable event IDs identify immutable payloads. */
export function createMessageFold(
  channelId: string,
  relayAuthor: string,
  options: { includeReplies?: boolean; signingAuthority?: string | undefined },
) {
  type Folded = {
    inputs: readonly string[];
    owners: ReadonlyMap<string, string | undefined>;
    row: ChannelMessage | undefined;
  };
  let cache = new Map<string, Folded>();
  return (
    events: readonly EventData[],
    agentOwner?: (pubkey: string) => string | undefined,
  ) => {
    const order = new Map(events.map((event, index) => [event, index]));
    const overlays = new Map<string, EventData[]>();
    for (const event of events) {
      if (channelRowKind(event.kind)) continue;
      for (const [name, value] of event.tags) {
        if (name !== "e" || !value) continue;
        const list = overlays.get(value) ?? [];
        list.push(event);
        overlays.set(value, list);
      }
    }
    const next = new Map<string, Folded>();
    const rows: ChannelMessage[] = [];
    for (const event of events) {
      if (!channelRowKind(event.kind)) continue;
      const related = new Set(overlays.get(event.id));
      for (const overlay of [...related])
        for (const child of overlays.get(overlay.id) ?? []) related.add(child);
      const subset = [
        event,
        ...[...related].sort(
          (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
        ),
      ];
      const inputs = subset.map(({ id }) => id);
      const previous = cache.get(event.id);
      let folded =
        previous &&
        previous.inputs.length === inputs.length &&
        previous.inputs.every((id, index) => id === inputs[index]) &&
        [...previous.owners].every(
          ([pubkey, owner]) => agentOwner?.(pubkey) === owner,
        )
          ? previous
          : undefined;
      if (!folded) {
        const owners = new Map<string, string | undefined>();
        folded = {
          inputs,
          owners,
          row: foldMessages(channelId, relayAuthor, subset, {
            ...options,
            collapseHuddles: false,
            agentOwner:
              agentOwner &&
              ((pubkey) => {
                const owner = agentOwner(pubkey);
                owners.set(pubkey, owner);
                return owner;
              }),
          }).find((row) => row.id === event.id),
        };
      }
      next.set(event.id, folded);
      if (folded.row) rows.push(folded.row);
    }
    cache = next;
    return collapseHuddleCards(rows, relayAuthor).sort(compareMessages);
  };
}
