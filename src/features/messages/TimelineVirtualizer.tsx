import {
  forwardRef,
  isValidElement,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { correctScrollTo, correctScrollTop } from "./scroll-correction";
import { createTimelineLayout, type TimelineCache } from "./timeline-layout";

export type { TimelineCache } from "./timeline-layout";

export type TimelineVirtualizerHandle = {
  /** Measured row sizes, keyed by row; seed a remount with `cache`. */
  readonly cache: TimelineCache;
  /** The scroll offset as of the last observed scroll. */
  readonly scrollOffset: number;
  readonly viewportSize: number;
  /** The row at a scroll offset, in scroller coordinates. */
  findItemIndex(offset: number): number;
  /** A row's offset from the list start, from measured or estimated sizes. */
  getItemOffset(index: number): number;
  /** Retained through late measurement until 150ms pass or reader input. */
  scrollToIndex(
    index: number,
    options?: { align?: "start" | "center" | "end"; offset?: number },
  ): void;
  scrollTo(offset: number): void;
};

export type TimelineVirtualizerProps = {
  children: ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
  /** Rows were prepended in this render: keep the distance from the end. */
  shift?: boolean;
  bufferSize?: number;
  keepMounted?: readonly number[];
  /** Scroller content above the list. */
  startMargin?: number;
  cache?: TimelineCache | undefined;
};

const IDLE = 0;
const DOWN = 1;
const UP = 2;
const NATIVE = 0;
const MANUAL = 1;
const SHIFT = 2;
// The first cold range assumes tall rows, then grows from their measurements,
// so it never mounts rows the measured viewport does not reach.
const PROBE_SIZE = 160;
const SCROLL_IDLE_MS = 150;
const INPUT_EVENTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

// Rows stay in normal flow: a mounted row is always at its true position, and
// only the space of unmounted rows (a row's top margin) is estimated.
const LIST_STYLE: CSSProperties = {
  contain: "size style",
  overflowAnchor: "none",
  flex: "none",
  position: "relative",
  width: "100%",
  // Contains the first row's margin without a stacking context.
  display: "flow-root",
};
const ITEM_STYLE: CSSProperties = { contain: "layout style" };

function createTimelineState(cache: TimelineCache | undefined) {
  const layout = createTimelineLayout(cache);
  let scroller: HTMLElement | null = null;
  let list: HTMLOListElement | null = null;
  let rerender = () => {};
  let viewport = 0;
  let startMargin = 0;
  let bufferSize = 0;
  let scrollTop = 0;
  let direction = IDLE;
  let mode = NATIVE;
  // Until something positions it, a timeline opens at its end.
  let anchoredEnd = true;
  let bufferReady = !layout.estimating();
  let fills = 0;
  // A correction this state owes the scroller, and corrections applied since
  // the last scroll event, which reports them.
  let jump = 0;
  let applied = 0;
  const shifted = new Set<string>();
  let shiftIdle = false;
  let rendered: readonly number[] = [];
  let renderedRange: readonly [number, number] = [0, -1];
  const elements = new Map<string, HTMLElement>();
  const keyOf = new WeakMap<Element, string>();
  const refs = new Map<string, (element: HTMLElement | null) => void>();
  const margins = new WeakMap<Element, number>();
  let scrollEnd: ReturnType<typeof setTimeout> | undefined;
  let rangeFrame: number | undefined;
  let wheeling = false;
  let touching = false;
  let lastScrollTime = 0;
  let cancelScroll: (() => void) | undefined;
  let retarget: (() => void) | undefined;
  let observer: ResizeObserver | undefined;

  const range = (): readonly [number, number] => {
    const length = layout.length();
    if (!viewport || !length) return [0, -1];
    const buffer = bufferReady && !layout.estimating() ? bufferSize : 0;
    if (anchoredEnd) {
      const need = viewport + buffer;
      let start = length;
      let covered = 0;
      while (start > 0 && covered < need) {
        start--;
        covered +=
          layout.measured(start) || !layout.estimating()
            ? layout.size(start)
            : PROBE_SIZE;
      }
      return [start, length - 1];
    }
    const top = scrollTop + applied + jump - startMargin;
    let from = top;
    let to = top + viewport;
    // Native scrolling buffers ahead of its direction only. A shift or an
    // imperative scroll freezes the direction, so it buffers both sides.
    if (direction !== DOWN || mode !== NATIVE) from -= buffer;
    if (direction !== UP || mode !== NATIVE) to += buffer;
    return [layout.find(Math.max(0, from)), layout.find(Math.max(0, to))];
  };
  const rangeChanged = () => {
    const [start, end] = range();
    return start !== renderedRange[0] || end !== renderedRange[1];
  };
  const shiftPending = () =>
    rendered.some((index) => {
      const key = layout.keys()[index];
      return key !== undefined && shifted.has(key) && !layout.measured(index);
    });
  const endShift = () => {
    mode = NATIVE;
    shifted.clear();
    shiftIdle = false;
  };

  // Virtua's anchor: the first row that a resize must not move. Rows above it
  // are compensated; a shift compensates everything above the viewport end.
  const anchorIndex = (top: number) => {
    const length = layout.length();
    if (mode === SHIFT) {
      const end = top + viewport;
      let anchor = layout.find(end);
      while (anchor < length && layout.offset(anchor) < end) anchor++;
      return anchor;
    }
    const keep = (index: number) => {
      const offset = layout.offset(index);
      const bottom = offset + layout.size(index);
      return direction !== DOWN && mode === NATIVE
        ? bottom <= top
        : offset < top && bottom < top + viewport;
    };
    let anchor = layout.find(top);
    while (anchor > 0 && !keep(anchor - 1)) anchor--;
    while (anchor < length && keep(anchor)) anchor++;
    return anchor;
  };

  const applyJump = () => {
    if (!jump || !scroller) return;
    const amount = jump;
    jump = 0;
    const end = startMargin + layout.total() - viewport;
    const from = scrollTop + applied;
    const to = from + amount;
    applied += amount;
    // Scroll APIs can truncate fractional offsets; reach the whole edge.
    if (to <= 0 || to >= end - 1 || from >= end)
      correctScrollTo(
        scroller,
        to >= end - 1 ? Math.ceil(Math.max(to, end)) : to,
      );
    else correctScrollTop(scroller, amount);
  };

  // A resize above the anchor moves the rows below it. While rows above the
  // mounted ones are unmounted, their estimated space takes the difference:
  // the anchor stays put, as with a scroll correction, but nothing scrolls.
  // One correction settles it when the gesture ends or the first row nears.
  const absorb = (moved: number) => {
    if (moved && (rendered[0] ?? 0) > 0)
      layout.setDrift(layout.drift() - moved);
    else jump += moved;
  };
  const settleDrift = (idle = false) => {
    const drift = layout.drift();
    const first = rendered[0];
    if (!drift || first === undefined) return;
    if (!idle && first > 0 && layout.offset(first) >= 0) return;
    layout.setDrift(0);
    jump -= drift;
  };

  // Mounted rows sit in flow; each top margin holds the rows not mounted above
  // it. Until a row measures, the next one keeps its estimated offset, as with
  // absolute rows, so a resize moves rows only through the anchor's correction.
  const applyLayout = () => {
    if (!list) return;
    const keys = layout.keys();
    const unmeasured = new Map<HTMLElement, number>();
    for (const index of rendered) {
      const element = elements.get(keys[index] ?? "");
      if (element && !layout.measured(index))
        unmeasured.set(element, element.getBoundingClientRect().height);
    }
    let expected = 0;
    for (const index of rendered) {
      const element = elements.get(keys[index] ?? "");
      if (!element) continue;
      const offset = layout.offset(index);
      const margin = offset - expected;
      if (margins.get(element) !== margin) {
        element.style.marginTop = margin ? `${margin}px` : "";
        margins.set(element, margin);
      }
      expected = offset + (unmeasured.get(element) ?? layout.size(index));
    }
    const height = `${layout.total()}px`;
    if (list.style.height !== height) list.style.height = height;
  };

  const scheduleRange = () => {
    if (rangeFrame !== undefined || !scroller) return;
    // Rendering from resize delivery would mount rows at the observed depth,
    // which WebKit skips; render the new range in an animation frame instead.
    rangeFrame = requestAnimationFrame(() => {
      rangeFrame = undefined;
      if (rangeChanged()) flushSync(rerender);
    });
  };

  const onResize = (entries: ResizeObserverEntry[]) => {
    const resizes: [string, number][] = [];
    let resized = false;
    for (const { target, contentRect } of entries) {
      if (target === scroller) {
        if (contentRect.height && contentRect.height !== viewport) {
          viewport = contentRect.height;
          resized = true;
        }
        continue;
      }
      const key = keyOf.get(target);
      if (key === undefined || elements.get(key) !== target) continue;
      // A hidden workspace reports empty rows; keep their sizes.
      if (!(target as HTMLElement).offsetParent) continue;
      if (layout.sizeOf(key) !== contentRect.height)
        resizes.push([key, contentRect.height]);
    }
    if (resizes.length && scroller) {
      // Layout is clean in resize delivery, so the native offset is cheap and
      // includes corrections the owner applied since the last scroll event.
      const top = scroller.scrollTop + jump - startMargin;
      const anchor = anchorIndex(top);
      const before = layout.offset(anchor);
      layout.setSizes(resizes, viewport);
      absorb(layout.offset(anchor) - before);
      for (const [key] of resizes) shifted.delete(key);
      if (shiftIdle && !shiftPending()) endShift();
      settleDrift();
      // The list grows before a correction, or the browser clamps it.
      applyLayout();
      applyJump();
      if (retarget) queueMicrotask(retarget);
    }
    if (resized) {
      // A viewport size mounts rows deeper than the scroller; render them now.
      if (rangeChanged()) flushSync(rerender);
      if (retarget) queueMicrotask(retarget);
    } else if (resizes.length && rangeChanged()) scheduleRange();
  };

  const onScrollEnd = () => {
    if (wheeling || touching) {
      wheeling = false;
      scheduleScrollEnd();
      return;
    }
    const scrolling = direction !== IDLE;
    direction = IDLE;
    if (mode === SHIFT && shiftPending()) shiftIdle = true;
    else endShift();
    if (list?.style.pointerEvents) list.style.pointerEvents = "";
    if (layout.drift()) {
      settleDrift(true);
      applyLayout();
      applyJump();
    }
    if (scrolling && rangeChanged()) rerender();
  };
  const scheduleScrollEnd = () => {
    clearTimeout(scrollEnd);
    scrollEnd = setTimeout(onScrollEnd, SCROLL_IDLE_MS);
  };
  const onScroll = () => {
    if (!scroller) return;
    lastScrollTime = Date.now();
    const top = scroller.scrollTop;
    const delta = top - scrollTop;
    if (!delta && mode === NATIVE) return;
    // The scroll event of a correction may report it in the other direction.
    const jumped = applied && Math.abs(delta) < Math.abs(applied) + 1;
    applied = 0;
    if (!jumped && mode === NATIVE) direction = delta < 0 ? UP : DOWN;
    scrollTop = top;
    anchoredEnd = false;
    if (direction !== IDLE && list && list.style.pointerEvents !== "none")
      list.style.pointerEvents = "none";
    scheduleScrollEnd();
    if (rangeChanged())
      Math.abs(delta) > viewport ? flushSync(rerender) : rerender();
  };
  const onWheel = (event: WheelEvent) => {
    if (wheeling || direction === IDLE || event.ctrlKey) return;
    const since = Date.now() - lastScrollTime;
    if (150 > since && 50 < since && event.deltaY) wheeling = true;
  };
  const onTouchStart = () => {
    touching = true;
  };
  const onTouchEnd = () => {
    touching = false;
  };
  // New reader input supersedes a retained imperative target.
  const cancelInput = () => cancelScroll?.();

  const scrollWith = (target: () => number) => {
    cancelScroll?.();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      if (retarget === apply) retarget = undefined;
      if (cancelScroll === stop) cancelScroll = undefined;
    };
    const apply = () => {
      if (stopped || !scroller) return;
      if (viewport) {
        clearTimeout(timer);
        timer = setTimeout(stop, SCROLL_IDLE_MS);
      }
      mode = MANUAL;
      anchoredEnd = false;
      const to = target();
      const end = startMargin + layout.total() - viewport;
      scroller.scrollTo({
        top: to >= end ? Math.ceil(to) : to,
        behavior: "instant",
      });
      scrollTop = scroller.scrollTop;
      applied = 0;
      if (rangeChanged()) rerender();
    };
    retarget = apply;
    cancelScroll = stop;
    apply();
  };

  const handle: TimelineVirtualizerHandle = {
    get cache() {
      return layout.snapshot();
    },
    get scrollOffset() {
      return scrollTop;
    },
    get viewportSize() {
      return viewport;
    },
    findItemIndex: (offset) => layout.find(offset - startMargin),
    getItemOffset: (index) => layout.offset(index),
    scrollToIndex(index, { align, offset = 0 } = {}) {
      const key =
        layout.keys()[Math.max(0, Math.min(index, layout.length() - 1))];
      // Measurements retarget the scroll; follow the row through insertions.
      scrollWith(() => {
        const keys = layout.keys();
        const at = Math.max(0, key === undefined ? 0 : keys.indexOf(key));
        return (
          offset +
          startMargin +
          layout.offset(at) +
          (align === "end"
            ? layout.size(at) - viewport
            : align === "center"
              ? (layout.size(at) - viewport) / 2
              : 0)
        );
      });
    },
    scrollTo: (offset) => scrollWith(() => offset),
  };

  return {
    handle,
    layout,
    range,
    setRerender(next: () => void) {
      rerender = next;
    },
    update(
      keys: readonly string[],
      props: { shift: boolean; startMargin: number; bufferSize: number },
    ) {
      startMargin = props.startMargin;
      bufferSize = props.bufferSize;
      const previous = layout.keys();
      if (props.shift && keys.length !== previous.length && previous.length) {
        const before = layout.total();
        const known = new Set(previous);
        // The rows a cold open measures are the newest; a page of older rows
        // takes the median of every row measured since.
        layout.reestimate();
        layout.setKeys(keys);
        jump += layout.total() - before;
        mode = SHIFT;
        shiftIdle = false;
        for (const key of keys) if (!known.has(key)) shifted.add(key);
      } else layout.setKeys(keys);
    },
    itemRef(key: string) {
      let ref = refs.get(key);
      if (!ref) {
        ref = (element) => {
          const previous = elements.get(key);
          if (previous && previous !== element) {
            observer?.unobserve(previous);
            elements.delete(key);
          }
          if (element) {
            elements.set(key, element);
            keyOf.set(element, key);
            observer?.observe(element);
          } else refs.delete(key);
        };
        refs.set(key, ref);
      }
      return ref;
    },
    mount(nextScroller: HTMLElement, nextList: HTMLOListElement) {
      scroller = nextScroller;
      list = nextList;
      const style = getComputedStyle(scroller);
      viewport =
        scroller.clientHeight -
        (Number.parseFloat(style.paddingTop) || 0) -
        (Number.parseFloat(style.paddingBottom) || 0);
      scrollTop = scroller.scrollTop;
      observer = new ResizeObserver(onResize);
      observer.observe(scroller);
      for (const element of elements.values()) observer.observe(element);
      scroller.addEventListener("scroll", onScroll, { passive: true });
      scroller.addEventListener("wheel", onWheel, { passive: true });
      scroller.addEventListener("touchstart", onTouchStart, { passive: true });
      scroller.addEventListener("touchend", onTouchEnd, { passive: true });
      scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
      for (const type of INPUT_EVENTS)
        scroller.addEventListener(type, cancelInput, {
          capture: true,
          passive: true,
        });
      return () => {
        cancelScroll?.();
        clearTimeout(scrollEnd);
        if (rangeFrame !== undefined) cancelAnimationFrame(rangeFrame);
        observer?.disconnect();
        observer = undefined;
        nextScroller.removeEventListener("scroll", onScroll);
        nextScroller.removeEventListener("wheel", onWheel);
        nextScroller.removeEventListener("touchstart", onTouchStart);
        nextScroller.removeEventListener("touchend", onTouchEnd);
        nextScroller.removeEventListener("touchcancel", onTouchEnd);
        for (const type of INPUT_EVENTS)
          nextScroller.removeEventListener(type, cancelInput, true);
        scroller = null;
        list = null;
      };
    },
    commit(indices: readonly number[], committed: readonly [number, number]) {
      rendered = indices;
      renderedRange = committed;
      if (!list) return;
      // An unpositioned cold open measures its rows before paint and grows its
      // range from them; later rows measure in the resize observer.
      if (anchoredEnd && fills < 8) {
        const keys = layout.keys();
        const resizes: [string, number][] = [];
        for (const index of indices) {
          const key = keys[index];
          const element = elements.get(key ?? "");
          if (key !== undefined && element && !layout.measured(index))
            resizes.push([key, element.getBoundingClientRect().height]);
        }
        if (resizes.length) {
          fills++;
          layout.setSizes(resizes, viewport);
        }
      }
      settleDrift();
      applyLayout();
      applyJump();
      if (rangeChanged()) rerender();
      else if (!bufferReady && !layout.estimating()) {
        bufferReady = true;
        // The buffer mounts after the first rows paint.
        requestAnimationFrame(() => {
          if (rangeChanged()) rerender();
        });
      }
    },
  };
}

/**
 * The channel timeline's virtualizer, anchored at the list end. It keeps
 * Virtua's handle and correction contract (patches/README.md) for the subset
 * ChannelTimeline uses, with three differences: rows are keyed by identity, so
 * a moved row keeps its size; rows render in flow, so a resize needs no
 * re-render, only a correction of the rows above the anchor; and a cold open
 * mounts the rows its measured viewport reaches at the end, not the estimated
 * rows at its top.
 */
export const TimelineVirtualizer = forwardRef<
  TimelineVirtualizerHandle,
  TimelineVirtualizerProps
>(function TimelineVirtualizer(
  {
    children,
    scrollRef,
    shift = false,
    bufferSize = 200,
    keepMounted,
    startMargin = 0,
    cache,
  },
  ref,
) {
  const [state] = useState(() => createTimelineState(cache));
  const [, rerender] = useReducer((version: number) => version + 1, 0);
  state.setRerender(rerender);
  const list = useRef<HTMLOListElement>(null);
  const items = (Array.isArray(children) ? children : [children]).filter(
    isValidElement,
  ) as ReactElement[];
  const keys = items.map((item, index) => String(item.key ?? index));
  state.update(keys, { shift, startMargin, bufferSize });
  const [start, end] = state.range();
  let indices: number[] = [];
  for (let index = start; index <= end; index++) indices.push(index);
  if (keepMounted?.length) {
    const mounted = new Set(indices);
    for (const index of keepMounted)
      if (index >= 0 && index < items.length) mounted.add(index);
    indices = [...mounted].sort((a, b) => a - b);
  }
  useImperativeHandle(ref, () => state.handle, [state]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !list.current) return;
    const dispose = state.mount(scroller, list.current);
    rerender();
    return dispose;
  }, [state, scrollRef]);
  useLayoutEffect(() => {
    state.commit(indices, [start, end]);
  });
  return (
    <ol ref={list} style={LIST_STYLE}>
      {indices.map((index) => {
        const key = keys[index] ?? String(index);
        return (
          <li key={key} ref={state.itemRef(key)} style={ITEM_STYLE}>
            {items[index]}
          </li>
        );
      })}
    </ol>
  );
});
