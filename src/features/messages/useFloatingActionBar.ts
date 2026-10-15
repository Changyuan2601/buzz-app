import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  behindActiveModal,
  observeModals,
} from "../../shared/design-system/modalLayer";

const floatingQuery = "(hover: hover) and (pointer: fine)";
// One MediaQueryList for every row: `matchMedia` allocates and evaluates the
// query on each call, and these run in every row's first render and every
// external-store snapshot read. The list itself tracks modality changes. Keyed
// on the `matchMedia` function so a replaced implementation is re-queried.
let floatingSource: typeof window.matchMedia | undefined;
let floatingList: MediaQueryList | undefined;
const floating = () => {
  if (floatingSource !== window.matchMedia) {
    floatingSource = window.matchMedia;
    floatingList = floatingSource?.(floatingQuery);
  }
  return floatingList;
};
const subscribe = (notify: () => void) => {
  const query = floating();
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
const snapshot = () => floating()?.matches ?? false;

const awaitingKeyboard = new Set<() => void>();
const activateKeyboardActions = (event: KeyboardEvent) => {
  if (event.key !== "Tab" || event.metaKey || event.ctrlKey) return;
  // Native Tab must see the real controls before choosing its destination,
  // including continuation rows with no preceding avatar/button to focus.
  flushSync(() => {
    for (const activate of awaitingKeyboard) activate();
  });
};

/** Defer untouched desktop controls, then preserve their state for the row's life. */
export function useMessageActionBarReady(
  rowRef: RefObject<HTMLDivElement | null> | undefined,
) {
  const [ready, setReady] = useState(
    () =>
      !rowRef ||
      !snapshot() ||
      document.documentElement.hasAttribute("data-keyboard-navigation"),
  );
  useEffect(() => {
    const row = rowRef?.current;
    if (ready || !row) return;
    const activate = () => setReady(true);
    const query = floating();
    const modalityChanged = () => {
      if (!query?.matches) activate();
    };
    if (
      !query?.matches ||
      row.matches(":hover") ||
      row.contains(document.activeElement) ||
      document.documentElement.hasAttribute("data-keyboard-navigation")
    ) {
      activate();
      return;
    }
    row.addEventListener("pointerenter", activate);
    row.addEventListener("focusin", activate);
    query.addEventListener("change", modalityChanged);
    if (awaitingKeyboard.size === 0)
      window.addEventListener("keydown", activateKeyboardActions, true);
    awaitingKeyboard.add(activate);
    return () => {
      row.removeEventListener("pointerenter", activate);
      row.removeEventListener("focusin", activate);
      query.removeEventListener("change", modalityChanged);
      awaitingKeyboard.delete(activate);
      if (awaitingKeyboard.size === 0)
        window.removeEventListener("keydown", activateKeyboardActions, true);
    };
  }, [ready, rowRef]);
  return ready;
}

/** Keep the controls in DOM/tab order while painting outside list containment. */
export function useFloatingActionBar(
  rowRef: RefObject<HTMLDivElement | null> | undefined,
  barRef: RefObject<HTMLDivElement | null>,
  slotRef: RefObject<HTMLDivElement | null>,
  open: boolean,
) {
  const floating = useSyncExternalStore(subscribe, snapshot, () => false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    if (!floating || !row || !bar) return;
    // Top-layer descendants don't contribute to :hover or :focus-within.
    let hovered = row.matches(":hover") || bar.matches(":hover");
    // Read modality with focus on every update: pointer focus must not pin the
    // bar when hover leaves, including after keyboard-to-pointer transitions.
    const keyboardFocus = () =>
      row.matches(":has(:focus-visible)") ||
      (document.documentElement.hasAttribute("data-keyboard-navigation") &&
        row.contains(document.activeElement));
    const update = (focused = keyboardFocus()) => {
      // Message accessories such as agent activity use ordinary portals. A
      // native top-layer toolbar must step aside while their popup is open.
      const accessoryOpen = [
        ...row.querySelectorAll(
          '[aria-haspopup="dialog"][aria-expanded="true"]',
        ),
      ].some((trigger) => !bar.contains(trigger));
      const next =
        !accessoryOpen &&
        (hovered ||
          focused ||
          open ||
          !!bar.querySelector('[aria-haspopup][aria-expanded="true"]'));
      row.toggleAttribute("data-actions-revealed", next);
      setRevealed(next);
    };
    const enter = () => {
      hovered = true;
      update();
    };
    const leave = () => {
      hovered = false;
      update();
    };
    const focusIn = () => update();
    const focusOut = (event: FocusEvent) => {
      update(
        event.relatedTarget instanceof Node &&
          row.contains(event.relatedTarget) &&
          keyboardFocus(),
      );
    };
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    row.addEventListener("focusin", focusIn);
    row.addEventListener("focusout", focusOut);
    const observer = new MutationObserver(() => {
      // Recheck focus if a control is removed without dispatching focusout.
      update();
    });
    observer.observe(row, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    update();
    return () => {
      row.removeEventListener("pointerenter", enter);
      row.removeEventListener("pointerleave", leave);
      row.removeEventListener("focusin", focusIn);
      row.removeEventListener("focusout", focusOut);
      observer.disconnect();
      row.removeAttribute("data-actions-revealed");
    };
  }, [floating, open, rowRef, barRef]);

  useLayoutEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    const slot = slotRef.current;
    if (!floating || !revealed || !row || !bar || !slot) return;
    const scroller = row.closest<HTMLElement>("[data-message-scroller]");
    const workspaceSelector = "[data-main-workspace], [data-panel-workspace]";
    const workspace = row.closest(workspaceSelector);
    let frame = 0;
    const hide = () => {
      if (bar.hasAttribute("popover")) bar.hidePopover?.();
      // Closed popovers return to their slot's containing block. Viewport offsets
      // there would create invisible overflow and interfere with scrolling.
      bar.style.top = "";
      bar.style.left = "";
      bar.style.right = "";
      bar.style.maxWidth = "";
      delete bar.dataset.placement;
    };
    const position = () => {
      // A frame can outlive the document that held the bar (for example after
      // the page content is replaced). showPopover throws on detached elements.
      if (!bar.isConnected) return;
      // Resolve the painted message again when edits replace text with media.
      const visual =
        row.querySelector<HTMLElement>("[data-message-action-anchor]") ??
        row.querySelector("[data-message-attachments]")?.firstElementChild ??
        slot;
      const anchor = visual.getBoundingClientRect();
      // A narrow side pane covers, but does not unmount, the channel. Keep its
      // native top-layer toolbar behind the frontmost workspace as it moves.
      const front =
        workspace &&
        document
          .elementsFromPoint(
            Math.max(
              0,
              Math.min(
                anchor.x + anchor.width / 2,
                document.documentElement.clientWidth - 1,
              ),
            ),
            Math.max(0, Math.min(anchor.top + 1, window.innerHeight - 1)),
          )
          .find(
            (element) =>
              !bar.contains(element) && element.closest(workspaceSelector),
          )
          ?.closest(workspaceSelector);
      if (front && front !== workspace) {
        hide();
        return;
      }
      // A top-layer toolbar can retain hover above a portalled modal's backdrop.
      // Keep actions in the active viewer usable, but suppress background rows.
      if (behindActiveModal(row)) {
        hide();
        return;
      }
      const viewport = scroller?.getBoundingClientRect();
      const style = getComputedStyle(bar);
      const overlap = Number.parseFloat(style.scrollMarginBlockStart) || 0;
      const rtl = getComputedStyle(row).direction === "rtl";
      // Own messages sit at the trailing edge; keep actions toward the conversation.
      const towardLeft = rtl !== row.hasAttribute("data-viewer-message");
      const gap = Number.parseFloat(style.scrollMarginInlineEnd) || 0;
      const rowBounds = row.getBoundingClientRect();
      const start =
        Math.max(0, viewport?.left ?? rowBounds.left) + (viewport ? gap : 0);
      const end =
        Math.min(
          document.documentElement.clientWidth,
          viewport?.right ?? rowBounds.right,
        ) - (viewport ? gap : 0);
      bar.style.maxWidth = `${Math.max(0, end - start)}px`;
      bar.showPopover?.();
      // Entrance motion must not change the layout used for placement.
      const width = bar.offsetWidth;
      const besideLeft = towardLeft
        ? anchor.left - overlap - width
        : anchor.right + overlap;
      const center = anchor.top + anchor.height / 2;
      const beside =
        besideLeft >= start &&
        besideLeft + width <= end &&
        (!viewport ||
          (center - bar.offsetHeight / 2 >= viewport.top &&
            center + bar.offsetHeight / 2 <= viewport.bottom));
      bar.dataset.placement = beside ? "beside" : "above";
      bar.style.transformOrigin = beside
        ? towardLeft
          ? "right center"
          : "left center"
        : rtl
          ? "left bottom"
          : "right bottom";
      const top = beside ? center : anchor.top + overlap;
      const paintedTop = top - bar.offsetHeight / (beside ? 2 : 1);
      if (
        viewport &&
        (anchor.top <= viewport.top || paintedTop >= viewport.bottom)
      ) {
        hide();
        return;
      }
      const left = beside
        ? besideLeft
        : rtl
          ? anchor.left - overlap
          : anchor.right - width + overlap;
      bar.style.top = `${top}px`;
      bar.style.left = `${Math.max(start, Math.min(left, end - width))}px`;
      bar.style.right = "auto";
    };
    // A transition or animation on the slot or an ancestor (such as a sliding
    // drawer) moves it without resizing, mutating or scrolling anything.
    const moving = () => {
      for (let node: Element | null = slot; node; node = node.parentElement)
        for (const animation of node.getAnimations?.() ?? [])
          if (
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime)
          )
            return true;
      return false;
    };
    let following = false;
    // Every move of the slot arrives through an event or observer below. Read
    // its rect once per frame from those, rather than polling it every frame and
    // forcing a layout whenever the timeline is mid-mutation. Only while finite
    // motion is in flight does it follow every frame, ending with a realignment
    // at the resting position.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        position();
        if (following) following = moving();
        if (following) schedule();
      });
    };
    const follow = () => {
      following = true;
      schedule();
    };
    const motion = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(slot)) follow();
    };
    const motionEvents = [
      "transitionrun",
      "transitionend",
      "transitioncancel",
      "animationstart",
      "animationend",
      "animationcancel",
    ];
    // Native top-layer boxes do not participate in their DOM ancestor's wheel
    // scroll chain. Keep scrolling the owning history when actions are under
    // the pointer; leave browser zoom gestures alone.
    const wheel = (event: WheelEvent) => {
      if (!scroller || event.ctrlKey || !bar.matches(":popover-open")) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroller.clientHeight
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? Number.parseFloat(getComputedStyle(scroller).lineHeight) || 16
            : 1;
      event.preventDefault();
      scroller.scrollBy({
        left: event.deltaX * unit,
        top: event.deltaY * unit,
        behavior: "instant",
      });
    };
    bar.addEventListener("wheel", wheel, { passive: false });
    position();
    if (moving()) follow();
    for (const type of motionEvents)
      document.addEventListener(type, motion, true);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    observer.observe(row);
    observer.observe(bar);
    // Sibling edits and media measurements move the slot without resizing any
    // observed node. The toolbar's own positioning writes must not retrigger it.
    const siblings = new MutationObserver((records) => {
      if (records.some((record) => !bar.contains(record.target))) schedule();
    });
    if (scroller) {
      observer.observe(scroller);
      siblings.observe(scroller, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    // Observe modals only while reveal is requested, and share the existing
    // coalesced positioning update.
    const unobserveModals = observeModals(schedule);
    return () => {
      bar.removeEventListener("wheel", wheel);
      cancelAnimationFrame(frame);
      for (const type of motionEvents)
        document.removeEventListener(type, motion, true);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      siblings.disconnect();
      unobserveModals();
      hide();
    };
  }, [floating, revealed, rowRef, barRef, slotRef]);

  return floating;
}
