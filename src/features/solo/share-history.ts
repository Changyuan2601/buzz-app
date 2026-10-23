import { viewRevision, writeView } from "../../shared/view-state";

/** Display provenance on this device, never membership or grant authority. */
export type ShareHistory = Readonly<{
  version: 1;
  channels: readonly Readonly<{
    id: string;
    name: string;
    members: readonly string[];
  }>[];
  people: readonly string[];
}>;
const empty: ShareHistory = { version: 1, channels: [], people: [] };
const bytes = 64 * 1024;
const keyPattern = /^[0-9a-f]{64}$/;
export const shareHistoryKey = (source: string) => `solo:shares:${source}`;
const unavailable = "Sharing history is unavailable on this device.";
function keys(value: unknown, limit: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some((key) => typeof key !== "string" || !keyPattern.test(key)) ||
    new Set(value).size !== value.length
  )
    throw new Error(unavailable);
  return value;
}
export function readShareHistory(raw: string | null | undefined): ShareHistory {
  if (raw === undefined) throw new Error(unavailable);
  if (raw === null) return empty;
  if (new TextEncoder().encode(raw).length > bytes)
    throw new Error(unavailable);
  let value: Partial<ShareHistory>;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(unavailable);
  }
  if (
    value?.version !== 1 ||
    !Array.isArray(value.channels) ||
    value.channels.length > 100
  )
    throw new Error(unavailable);
  const channels = value.channels.map((channel) => {
    if (
      !channel ||
      typeof channel.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(channel.id) ||
      typeof channel.name !== "string" ||
      !channel.name.trim() ||
      channel.name.length > 256
    )
      throw new Error(unavailable);
    return {
      id: channel.id,
      name: channel.name,
      members: keys(channel.members, 1000),
    };
  });
  if (new Set(channels.map((channel) => channel.id)).size !== channels.length)
    throw new Error(unavailable);
  return { version: 1, channels, people: keys(value.people, 1000) };
}

/** Merge only roster-confirmed recipients. Failure leaves access/Outbox alone;
 * malformed prior history is not silently overwritten. No cross-window CAS claim. */
export function saveShareHistory(
  scope: string,
  source: string,
  people: readonly string[],
  channel?: ShareHistory["channels"][number],
) {
  const key = shareHistoryKey(source);
  const current = readShareHistory(viewRevision(scope, key));
  const previous = current.channels.find((item) => item.id === channel?.id);
  const next = {
    version: 1,
    people: [...new Set([...current.people, ...people])],
    channels: channel
      ? [
          ...current.channels.filter((item) => item.id !== channel.id),
          {
            ...channel,
            members: [
              ...new Set([...(previous?.members ?? []), ...channel.members]),
            ],
          },
        ]
      : current.channels,
  };
  const serialized = JSON.stringify(next);
  if (new TextEncoder().encode(serialized).length > bytes)
    throw new Error(
      "Sharing history is full on this device. Access is unchanged.",
    );
  readShareHistory(serialized);
  if (!writeView(scope, key, next))
    throw new Error(
      "Sharing history couldn’t be saved on this device. Access is unchanged.",
    );
}
