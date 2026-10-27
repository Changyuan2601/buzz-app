import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Virtualizer,
  type VirtualizerHandle,
  type CustomItemComponentProps,
} from "virtua";

function Item({ children, index, ref, style }: CustomItemComponentProps) {
  return (
    <li ref={ref} style={style} data-thread-window-index={index}>
      {children}
    </li>
  );
}

/** Window whole reply branches, retaining the reader's single scrollport. */
export function ThreadReplyWindow({
  children,
  scroller,
  keepMounted,
  initialIndex,
  onReady,
  follow,
}: {
  children: ReactNode[];
  scroller: RefObject<HTMLElement | null>;
  keepMounted: readonly number[];
  initialIndex: number | undefined;
  onReady(): void;
  follow: RefObject<boolean>;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<VirtualizerHandle>(null);
  const [startMargin, setStartMargin] = useState(0);
  const [focused, setFocused] = useState<string>();
  const ready = useRef(false);
  const check = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const element = scroller.current;
    const container = wrapper.current;
    if (!element || !container) return;
    const measure = () =>
      setStartMargin(
        container.getBoundingClientRect().top -
          element.getBoundingClientRect().top +
          element.scrollTop,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Root media can change the list's offset without changing the list itself.
    if (container.parentElement) observer.observe(container.parentElement);
    return () => observer.disconnect();
  }, [scroller]);
  useEffect(() => {
    const element = scroller.current;
    const container = wrapper.current;
    if (!element || !container) return;
    let frame = 0;
    const position = () => {
      if (ready.current || !list.current?.viewportSize) return;
      const index = initialIndex;
      if (index === undefined) element.scrollTop = 0;
      else if (index === children.length - 1)
        element.scrollTop = element.scrollHeight;
      else list.current.scrollToIndex(index, { align: "center" });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target =
          index === undefined
            ? container
            : container.querySelector(`[data-thread-window-index="${index}"]`);
        if (!target) return;
        const bounds = target.getBoundingClientRect();
        const viewport = element.getBoundingClientRect();
        if (
          index !== undefined &&
          (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom)
        )
          return;
        if (
          index === children.length - 1 &&
          element.scrollHeight - element.clientHeight - element.scrollTop > 1
        )
          return;
        ready.current = true;
        onReady();
      });
    };
    check.current = position;
    // Virtua attaches to the external scrollport in its effect.
    frame = requestAnimationFrame(position);
    let height = "";
    const observer = new MutationObserver(() => {
      const nextHeight = container.querySelector("ol")?.style.height ?? "";
      // Virtua writes its list height during ResizeObserver delivery. Observe
      // that committed height, as ChannelTimeline does, rather than relying on
      // another parent resize notification in the same delivery cycle.
      if (nextHeight !== height) {
        height = nextHeight;
        if (ready.current && follow.current)
          element.scrollTop = element.scrollHeight;
      }
      position();
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      check.current = () => {};
    };
  }, [children.length, initialIndex, onReady, scroller, follow]);
  return (
    <div
      ref={wrapper}
      data-thread-window=""
      onFocusCapture={(event) => {
        const item = event.target.closest<HTMLElement>(
          "[data-thread-window-index]",
        );
        const child = item
          ? children[Number(item.dataset.threadWindowIndex)]
          : undefined;
        setFocused(
          isValidElement(child) ? (child.key ?? undefined) : undefined,
        );
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(undefined);
      }}
    >
      <Virtualizer
        ref={list}
        scrollRef={scroller}
        as="ol"
        item={Item}
        startMargin={startMargin}
        keepMounted={
          focused === undefined
            ? keepMounted
            : [
                ...keepMounted,
                ...children.flatMap((child, index) =>
                  isValidElement(child) && child.key === focused ? [index] : [],
                ),
              ]
        }
        onResize={() => check.current()}
      >
        {children}
      </Virtualizer>
    </div>
  );
}
