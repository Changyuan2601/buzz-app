import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerAccessory,
  ComposerAccessoryProps,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function ComposerAccessories({
  registry,
  ...props
}: ComposerAccessoryProps & {
  registry: ContributionReader<ComposerAccessory>;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const order = (entry: ComposerAccessory) =>
    Number.isFinite(entry.order) ? (entry.order ?? 0) : 0;
  const ordered = entries
    .filter((entry) => (entry.placement === "message") === !!props.message)
    .sort(
      (a, b) =>
        order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const decorator = props.renderMessageSummary
    ? ordered.find((entry) => entry.decoratesMessageSummary)
    : undefined;
  return (
    <>
      {!decorator && props.renderMessageSummary?.()}
      {ordered.map((entry) => (
        <ContributionBoundary
          key={`${contributionKey(entry)}:${props.scope}:${props.channelId}:${props.message?.id ?? props.threadRootId ?? ""}`}
          fallback={
            <>
              {entry === decorator && props.renderMessageSummary?.()}
              <p role="status">{entry.title} unavailable</p>
            </>
          }
        >
          <OwnedAccessory
            entry={entry}
            registry={registry}
            {...props}
            renderMessageSummary={
              entry === decorator ? props.renderMessageSummary : undefined
            }
          />
        </ContributionBoundary>
      ))}
    </>
  );
}
function OwnedAccessory({
  entry,
  registry,
  ...props
}: ComposerAccessoryProps & {
  entry: Contribution<ComposerAccessory>;
  registry: ContributionReader<ComposerAccessory>;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const canOpenThread = !!props.openThread;
  // Commands go inert when this owner unmounts or its inputs change. Build
  // them during render so the accessory mounts in the first pass.
  const owner = useMemo(() => {
    const token = { live: true };
    const session = props.session;
    const active = () =>
      token.live &&
      registry.snapshot().includes(entry) &&
      current.current.session === session;
    const commands: Pick<
      ComposerAccessoryProps,
      "canOpen" | "open" | "openThread" | "onFocusedRemoval"
    > = {
      canOpen: (target) => active() && current.current.canOpen(target),
      open: (target) => active() && current.current.open(target),
      onFocusedRemoval: () => {
        if (active()) current.current.onFocusedRemoval?.();
      },
      openThread: canOpenThread
        ? () => active() && (current.current.openThread?.() ?? false)
        : undefined,
    };
    return { token, commands };
  }, [entry, registry, props.session, canOpenThread]);
  useLayoutEffect(() => {
    owner.token.live = true;
    return () => {
      owner.token.live = false;
    };
  }, [owner]);
  const commands = owner.commands;
  const Accessory = entry.component;
  return <Accessory {...props} {...commands} />;
}
