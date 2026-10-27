// A port between pages in two webviews of this app, over Tauri events. The
// agents protocol needs each message once and in the order sent: a call's
// answer must not overtake the state push before it. Separate emits can
// arrive out of order, so each frame is numbered and held until its turn.
//
// Either page may load first, and either may reload. Each page load is a
// session. A page announces its session once it listens, and answers a new
// peer's announcement with its own; until it knows the peer's session it
// holds what it sends. Frames name the session they are for, so a frame
// meant for a page that has since reloaded is dropped.
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentsPort } from "./port";

const EVENT = "buzz://agents-port";

export type Frame = Readonly<
  {
    /** The webviews it is for and from. */
    to: string;
    by: string;
    /** The sending page load. */
    from: string;
  } & (
    | { kind: "ready" }
    | { kind: "message"; for: string; seq: number; data: unknown }
  )
>;

export type Events = Readonly<{
  emitTo(webview: string, event: string, payload: Frame): Promise<void>;
  listen(
    event: string,
    handler: (event: { payload: Frame }) => void,
  ): Promise<UnlistenFn>;
}>;

/** A port from this page, in webview `from`, to the page in webview `to`.
 * Messages are JSON: a value JSON cannot carry does not arrive as sent.
 * What this page sends before the peer's page is up waits for it; what it
 * sent to a peer page that reloaded is lost with that page. */
export function eventPort(
  from: string,
  to: string,
  events: Events = { emitTo, listen },
): AgentsPort {
  const session = crypto.randomUUID();
  let closed = false;
  let peer: string | undefined;
  let sent = 0;
  let next = 0;
  const waiting: unknown[] = [];
  const held = new Map<number, unknown>();
  // Peer pages that have since reloaded: their late frames are stale.
  const retired = new Set<string>();
  const emit = (frame: Frame) =>
    events.emitTo(to, EVENT, frame).catch((error: unknown) => {
      console.error("Agents port message was not sent", error);
    });
  const send = (data: unknown) => {
    if (peer)
      void emit({
        to,
        by: from,
        from: session,
        kind: "message",
        for: peer,
        seq: sent++,
        data,
      });
  };
  const port: AgentsPort = {
    onmessage: null,
    postMessage(data) {
      if (closed) return;
      if (peer) send(data);
      else waiting.push(data);
    },
    close() {
      closed = true;
      waiting.length = 0;
      held.clear();
      void unlisten.then((stop) => stop());
    },
  };
  // A new peer page: what was sent to the last one is gone with it.
  const meet = (other: string) => {
    if (peer) retired.add(peer);
    peer = other;
    sent = 0;
    next = 0;
    held.clear();
    for (const data of waiting.splice(0)) send(data);
  };
  const unlisten = events
    .listen(EVENT, ({ payload: frame }) => {
      if (closed || frame.to !== from || frame.by !== to) return;
      if (frame.from !== peer && retired.has(frame.from)) return;
      if (frame.kind === "ready") {
        if (frame.from === peer) return;
        meet(frame.from);
        void emit({ to, by: from, from: session, kind: "ready" });
        return;
      }
      if (frame.for !== session) return;
      // It knows this page, so its announcement is on the way or was missed.
      if (frame.from !== peer) meet(frame.from);
      held.set(frame.seq, frame.data);
      while (held.has(next) && !closed) {
        const data = held.get(next);
        held.delete(next);
        next += 1;
        port.onmessage?.(new MessageEvent("message", { data }));
      }
    })
    .then((stop) => {
      if (!closed) void emit({ to, by: from, from: session, kind: "ready" });
      return stop;
    })
    .catch((error: unknown): UnlistenFn => {
      console.error("Agents port is not listening", error);
      return () => {};
    });
  return port;
}
