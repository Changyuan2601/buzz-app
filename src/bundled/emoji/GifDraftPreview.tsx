import { useSyncExternalStore } from "react";
import type {
  ComposerTool,
  ContributionReader,
} from "../../features/conversation/contracts";
import { safeMessageUrl } from "../../features/relay/message-content";
import styles from "./Emoji.module.css";

const emptyTools = { subscribe: () => () => {}, snapshot: () => false };

/** The bundled renderer follows the same activation lifetime as its picker. */
export function useGifDraftPreview(
  tools: ContributionReader<ComposerTool> | undefined,
) {
  const active = useSyncExternalStore(
    tools?.subscribe ?? emptyTools.subscribe,
    tools
      ? () =>
          tools
            .snapshot()
            .some(
              (tool) => tool.pluginId === "buzz.emoji" && tool.id === "picker",
            )
      : emptyTools.snapshot,
    emptyTools.snapshot,
  );
  return active ? gifDraftPreview : undefined;
}

/** Presentation only: the editor retains the exact Markdown for undo and sending. */
export function gifDraftPreview(
  url: string | undefined,
  title: string | null | undefined,
  media: (url: string) => string | undefined,
) {
  if (!url || !safeMessageUrl(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!/\.gif$/i.test(parsed.pathname)) return;
  const source = media(url);
  if (!source) return;
  return (
    <span className={styles.gifDraftPreview}>
      <img
        data-gif-preview
        src={source}
        alt={title || "GIF"}
        draggable={false}
      />
    </span>
  );
}
