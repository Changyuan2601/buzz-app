import type { OutgoingEvent } from "../relay/outbox";
import type { Recipient } from "../direct-messages/usePeople";

export type MemoryLevel = "none" | "core" | "everything";

export function snapshotRecoveryKey(kind: "agent" | "team", sourceId: string) {
  if (!sourceId || sourceId.length > 129)
    throw new Error("Sharing requires a stable source identity.");
  return `snapshot-share:${kind}:${sourceId}`;
}

/** Restore intent metadata only. Encoded files and plaintext memory never enter recovery. */
export function recoverSnapshot(
  operations: readonly OutgoingEvent[],
  key: string,
) {
  const matches = operations.filter((item) => item.recovery?.key === key);
  if (matches.length > 1)
    throw new Error("Multiple sharing operations need reconciliation.");
  const item = matches[0];
  if (!item?.recovery) return;
  const value = JSON.parse(item.recovery.value);
  const channelId = item.event.tags.find(([name]) => name === "h")?.[1];
  if (
    item.event.kind !== 9 ||
    !channelId ||
    !["none", "core", "everything"].includes(value.level) ||
    !Array.isArray(value.people) ||
    !value.people.length ||
    value.people.length > 8 ||
    value.people.some(
      (person: Recipient) =>
        !person ||
        typeof person.pubkey !== "string" ||
        !/^[0-9a-f]{64}$/.test(person.pubkey) ||
        typeof person.name !== "string" ||
        person.name.length > 500 ||
        (person.isAgent !== undefined && typeof person.isAgent !== "boolean"),
    ) ||
    new Set(value.people.map((person: Recipient) => person.pubkey)).size !==
      value.people.length
  )
    throw new Error("The saved sharing operation could not be restored.");
  return {
    receipt: { eventId: item.event.id, channelId },
    people: value.people as Recipient[],
    level: value.level as MemoryLevel,
  };
}

export function snapshotRecoveryValue(
  people: readonly Recipient[],
  level: MemoryLevel,
) {
  return JSON.stringify({
    people: people.map(({ pubkey, name, isAgent }) => ({
      pubkey,
      name: name.slice(0, 500),
      ...(isAgent === true ? { isAgent: true } : {}),
    })),
    level,
  });
}
