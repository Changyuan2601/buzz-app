import { useLayoutEffect, useState, type RefObject } from "react";
import { ArrowDownIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { useActivityLaneShown, type ActivityLane } from "./activity-lane";
import styles from "./Messages.module.css";

export type { ActivityLane } from "./activity-lane";

export function JumpToLatestButton({
  visible,
  newMessageCount,
  onClick,
  activityLane,
}: {
  visible: boolean;
  newMessageCount: number;
  onClick(): void;
  activityLane?: ActivityLane | undefined;
}) {
  // One element whether or not a lane applies, so a gate flip keeps focus.
  const lane = useActivityLaneShown(activityLane);
  const label =
    newMessageCount > 0
      ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
      : "Jump to latest";
  return (
    <div
      className={styles.jumpToLatest}
      inert={!visible}
      aria-hidden={!visible}
      data-visible={visible}
      data-activity-lane={lane || undefined}
    >
      <div className={styles.jumpToLatestSurface}>
        <Button
          data-jump-to-latest=""
          size="xs"
          shape="capsule"
          variant="ghost"
          onClick={onClick}
        >
          <ArrowDownIcon size={16} aria-hidden="true" />
          {label}
        </Button>
      </div>
    </div>
  );
}

export type JumpToLatest = {
  get(): { visible: boolean; newMessageCount: number };
  set(next: { visible?: boolean; newMessageCount?: number }): void;
  subscribe(listener: () => void): () => void;
};

// Scroll events report visibility every frame. Holding it outside the
// timeline's state re-renders only the button, and only when it changes.
export function createJumpToLatest(): JumpToLatest {
  let state = { visible: false, newMessageCount: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const visible = next.visible ?? state.visible;
      const newMessageCount = next.newMessageCount ?? state.newMessageCount;
      if (
        visible === state.visible &&
        newMessageCount === state.newMessageCount
      )
        return;
      state = { visible, newMessageCount };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function JumpToLatestControl({
  state,
  scroller,
  onClick,
  activityLane,
}: {
  state: JumpToLatest;
  scroller: RefObject<HTMLElement | null>;
  onClick(): void;
  activityLane?: ActivityLane | undefined;
}) {
  // A state update keeps the scroll event's priority, so the button renders
  // with Virtua's own update instead of in a forced synchronous commit.
  const [{ visible, newMessageCount }, setSnapshot] = useState(state.get);
  useLayoutEffect(() => {
    setSnapshot(state.get());
    return state.subscribe(() => setSnapshot(state.get()));
  }, [state]);
  // The scroller carries the same state for the composer-context edge.
  useLayoutEffect(() => {
    scroller.current?.toggleAttribute("data-jump-visible", visible);
  }, [scroller, visible]);
  return (
    <JumpToLatestButton
      visible={visible}
      newMessageCount={newMessageCount}
      onClick={onClick}
      activityLane={activityLane}
    />
  );
}
