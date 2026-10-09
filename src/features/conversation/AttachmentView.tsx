import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type {
  AttachmentRenderer,
  AttachmentRendererProps,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function AttachmentView({
  registry,
  fallback,
  ...props
}: AttachmentRendererProps & {
  registry: ContributionReader<AttachmentRenderer>;
  fallback: ReactNode;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const entry = entries.find((candidate) => {
    try {
      return candidate.matches(props.attachment);
    } catch {
      return false;
    }
  });
  if (!entry) return fallback;
  const Renderer = entry.component;
  return (
    <ContributionBoundary key={contributionKey(entry)} fallback={fallback}>
      <Renderer {...props} />
    </ContributionBoundary>
  );
}
