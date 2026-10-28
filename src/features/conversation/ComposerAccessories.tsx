import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
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
  const session = props.session;
  // The first render binds commands, so a mounting row renders its accessory
  // in one pass; a changed owner or session rebinds them before paint.
  const [binding, setBinding] = useState(() =>
    bind(entry, registry, session, canOpenThread, current),
  );
  const unadopted = useRef<Binding | undefined>(binding);
  useLayoutEffect(() => {
    const adopted =
      unadopted.current ??
      bind(entry, registry, session, canOpenThread, current);
    if (!unadopted.current) setBinding(adopted);
    unadopted.current = undefined;
    return () => {
      adopted.live = false;
    };
  }, [entry, registry, session, canOpenThread]);
  const Accessory = entry.component;
  return <Accessory {...props} {...binding.commands} />;
}
type Commands = Pick<
  ComposerAccessoryProps,
  "canOpen" | "open" | "openThread" | "onFocusedRemoval"
>;
type Binding = { live: boolean; commands: Commands };
function bind(
  entry: Contribution<ComposerAccessory>,
  registry: ContributionReader<ComposerAccessory>,
  session: ComposerAccessoryProps["session"],
  canOpenThread: boolean,
  current: { current: ComposerAccessoryProps },
): Binding {
  const binding: Binding = {
    live: true,
    commands: {
      canOpen: (target) => active() && current.current.canOpen(target),
      open: (target) => active() && current.current.open(target),
      onFocusedRemoval: () => {
        if (active()) current.current.onFocusedRemoval?.();
      },
      openThread: canOpenThread
        ? () => active() && (current.current.openThread?.() ?? false)
        : undefined,
    },
  };
  const active = () =>
    binding.live &&
    registry.snapshot().includes(entry) &&
    current.current.session === session;
  return binding;
}
