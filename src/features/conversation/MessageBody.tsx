import { useSyncExternalStore, type ReactNode } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { ContributionReader, MessageRenderer } from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { WithTargetOpener } from "./opener";

/** First active match wins; a broken optional renderer leaves the host fallback. */
export function MessageBody({
  registry,
  message,
  children,
}: {
  registry: ContributionReader<MessageRenderer>;
  message: ChannelMessage;
  children: ReactNode;
}) {
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const renderer = renderers.find((entry) => {
    try {
      return entry.matches(message);
    } catch {
      return false;
    }
  });
  if (!renderer) return children;
  return (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${message.channelId}:${message.id}`}
      fallback={children}
    >
      <WithTargetOpener
        component={renderer.component}
        props={{ message }}
        registry={registry}
        entry={renderer}
      />
    </ContributionBoundary>
  );
}
