import type { RelayEvent } from "../relay/events";
import type { KitRecord, PayloadRecord } from "./model";
export interface ChannelKitHost {
  prepare(
    record: KitRecord | PayloadRecord,
    signal: AbortSignal,
  ): Promise<string>;
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<{ eventId: string; record: KitRecord | PayloadRecord }[]>;
}
