import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type {
  AttachmentRenderer,
  AttachmentRendererProps,
  ContributionReader,
  TargetOpener,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { WithTargetOpener } from "./opener";

export function AttachmentView({
  registry,
  fallback,
  ...props
}: Omit<AttachmentRendererProps, keyof TargetOpener> & {
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
  return (
    <ContributionBoundary key={contributionKey(entry)} fallback={fallback}>
      <WithTargetOpener
        component={entry.component}
        props={props}
        registry={registry}
        entry={entry}
      />
    </ContributionBoundary>
  );
}
