import {
  useCallback,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";

type Sent = { channelId: string; id: string } | undefined;

/**
 * The composer's last sent message, kept outside the workspace's state so a
 * send re-renders only the timeline that reveals it.
 */
export function createSentReveal() {
  let sent: Sent;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => sent,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: ((next) => {
      const value = typeof next === "function" ? next(sent) : next;
      if (value === sent) return;
      sent = value;
      for (const listener of listeners) listener();
    }) as Dispatch<SetStateAction<Sent>>,
  };
}
export type SentReveal = ReturnType<typeof createSentReveal>;

/** The sent message to reveal in this channel's timeline. */
export function useSentReveal(reveal: SentReveal, channelId: string) {
  const sent = useSyncExternalStore(
    reveal.subscribe,
    reveal.snapshot,
    reveal.snapshot,
  );
  return sent?.channelId === channelId ? sent.id : undefined;
}

/** Keep the mounted composer's callback stable while unrelated workspace data moves. */
export function useComposerSent(
  channelId: string | undefined,
  setSent: Dispatch<SetStateAction<Sent>>,
) {
  return useCallback(
    (id: string) => {
      if (!channelId) return;
      setSent({ channelId, id });
    },
    [channelId, setSent],
  );
}
