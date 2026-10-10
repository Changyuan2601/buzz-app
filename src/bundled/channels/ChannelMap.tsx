import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { ChannelQueries } from "../../features/relay/contracts";
import { canvasMapBlocks } from "./canvas-map";
import styles from "./ChannelMap.module.css";

// Mapbox GL is large and needs WebGL; load it only for map channels.
const CanvasMap = lazy(() =>
  import("./CanvasMap").then(({ CanvasMap }) => ({ default: CanvasMap })),
);

const unsubscribed = () => () => {};

/**
 * The first ```map block in a channel's Canvas. Canvas has no live feed, so
 * it is re-read whenever the conversation gains a message: an agent updates
 * the map with `buzz canvas set`, then explains the change in the chat.
 */
export function useChannelCanvasMap(
  canvas: ChannelCanvas,
  channels: ChannelQueries,
  channelId: string | undefined,
  /** Changes force a re-read, for example after the Canvas dialog closes. */
  refresh: number,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      channelId
        ? channels.subscribeWindow(channelId, listener)
        : unsubscribed(),
    [channels, channelId],
  );
  const newest = useSyncExternalStore(subscribe, () =>
    channelId ? channels.window(channelId).rows.at(-1)?.id : undefined,
  );
  const [found, setFound] = useState<{ channelId: string; source?: string }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: newest and refresh only trigger re-reads.
  useEffect(() => {
    if (!channelId || !canvas.available) return;
    let live = true;
    canvas.read(channelId).then(
      (event) => {
        if (!live) return;
        const [source] = canvasMapBlocks(event?.content ?? "");
        setFound(source ? { channelId, source } : { channelId });
      },
      // Unreadable Canvas (for example a read-only channel) means no map.
      () => {
        if (live) setFound({ channelId });
      },
    );
    return () => {
      live = false;
    };
  }, [canvas, channelId, newest, refresh]);
  return found && found.channelId === channelId ? found.source : undefined;
}

/** The map fills the conversation area; the chat docks beside it. */
export function ChannelMapSplit({
  source,
  children,
}: {
  /** Without a map the conversation renders as usual. */
  source: string | undefined;
  children: ReactNode;
}) {
  if (!source) return children;
  return (
    <div className={styles.split}>
      <Suspense
        fallback={
          <p role="status" className={styles.loading}>
            Loading map…
          </p>
        }
      >
        <CanvasMap fill source={source} />
      </Suspense>
      <section aria-label="Map conversation" className={styles.chat}>
        {children}
      </section>
    </div>
  );
}
