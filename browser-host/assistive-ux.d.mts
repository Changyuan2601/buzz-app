import type {
  ProgressAddress,
  ProgressFact,
} from "../src/features/assistive-ux/protocol";
import type { RelayEvent } from "../src/features/relay/events";
export function assistiveAddresses(
  secret: Uint8Array,
  community: string,
): ProgressAddress[];
export function decodeAssistive(
  events: readonly RelayEvent[],
  secret: Uint8Array,
  community: string,
): { eventId: string; fact: ProgressFact }[];
export function signAssistive(
  fact: ProgressFact,
  secret: Uint8Array,
  community: string,
  now?: number,
): RelayEvent;
