import { verifyEvent, type Event } from "nostr-tools";

self.onmessage = (message: MessageEvent<{ id: number; events: Event[] }>) => {
  const { id, events } = message.data;
  self.postMessage({ id, valid: events.map((event) => verifyEvent(event)) });
};
