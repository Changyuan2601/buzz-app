import { mergeProps } from "@base-ui/react/merge-props";
import {
  cloneElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";

type ElementProps = Record<string, unknown>;
type Handler = (event: SyntheticEvent) => void;
type RefCallback = (element: HTMLElement | null) => (() => void) | undefined;

/**
 * Most hint, preview and menu triggers are never used, yet a Base UI root and
 * trigger build a store, floating interaction hooks and context providers when
 * they mount. A deferred trigger renders its element with the closed
 * trigger's attributes until the first pointer, focus or press reaches it.
 * That interaction mounts the root synchronously, inside the same input
 * event, and is then handed to Base UI as if it had always been mounted, so
 * a press can never land before the root does.
 *
 * Base UI's trigger renders into a relay instead of the element: the element
 * keeps its place in the tree and is never remounted, and the relay forwards
 * the trigger's ref, attributes and handlers to it.
 */
export function useDeferredTrigger({
  node,
  child,
  own,
  open,
  resting,
  activateOn,
}: {
  /** Receives the trigger element. */
  node: RefObject<HTMLElement | null>;
  /** The trigger element, rendered as Base UI's `render` element would be. */
  child: ReactElement;
  /** Props the component adds to the trigger, as Base UI element props. */
  own?: ElementProps | undefined;
  /** A controlled open needs the root even without an interaction. */
  open: boolean | undefined;
  /** The attributes Base UI's closed trigger renders. */
  resting: ElementProps;
  /** The interactions that need Base UI, such as `onPointerEnter`. */
  activateOn: readonly string[];
}) {
  const [live, setLive] = useState(false);
  if (open && !live) setLive(true);
  const liveRef = useRef(live);
  liveRef.current = live;
  const latest = useRef<ElementProps>({});
  const attached = useRef<{
    ref?: RefCallback | undefined;
    cleanup?: undefined | (() => void);
  }>({});
  const [applied, setApplied] = useState<{
    attributes: ElementProps;
    handlers: string[];
  }>({ attributes: {}, handlers: [] });
  const delegates = useRef(new Map<string, Handler>());

  const deliver = useCallback(
    (props: ElementProps | null) => {
      const { ref, ...rest } = props ?? {};
      latest.current = rest;
      if (ref !== attached.current.ref) {
        const previous = attached.current;
        if (previous.cleanup) previous.cleanup();
        else previous.ref?.(null);
        const next = ref as RefCallback | undefined;
        attached.current = {
          ref: next,
          cleanup: next?.(node.current) ?? undefined,
        };
      }
      const attributes: ElementProps = {};
      const handlers: string[] = [];
      for (const [name, value] of Object.entries(rest)) {
        if (typeof value === "function") handlers.push(name);
        else if (value !== undefined) attributes[name] = value;
      }
      setApplied((current) =>
        sameEntries(current.attributes, attributes) &&
        current.handlers.join() === handlers.join()
          ? current
          : { attributes, handlers },
      );
    },
    [node],
  );

  const relay = useCallback(
    (props: object) => (
      <TriggerRelay props={props as ElementProps} deliver={deliver} />
    ),
    [deliver],
  );

  const childProps = child.props as ElementProps;
  const childRef = childProps.ref as Ref<HTMLElement> | undefined;
  const ref = useCallback(
    (element: HTMLElement | null) => {
      node.current = element;
      const cleanup =
        typeof childRef === "function" ? childRef(element) : undefined;
      if (childRef && typeof childRef === "object") childRef.current = element;
      return () => {
        node.current = null;
        if (typeof cleanup === "function") cleanup();
        else if (typeof childRef === "function") childRef(null);
        else if (childRef) childRef.current = null;
      };
    },
    [childRef, node],
  );

  const props: ElementProps = live ? { ...applied.attributes } : { ...resting };
  for (const name of live ? applied.handlers : activateOn) {
    let handler = delegates.current.get(name);
    if (!handler) {
      handler = (event) => {
        if (!liveRef.current) {
          flushSync(() => setLive(true));
          // Base UI hears mouseenter natively. Input always reaches the
          // element with pointer events first, but a mouse-only sequence
          // may already have dispatched mouseenter before React's mouseover.
          if (event.type === "mouseenter") {
            const { clientX, clientY, relatedTarget } =
              event.nativeEvent as MouseEvent;
            node.current?.dispatchEvent(
              new MouseEvent("mouseenter", {
                clientX,
                clientY,
                relatedTarget,
              }),
            );
          }
        }
        (latest.current[name] as Handler | undefined)?.(event);
      };
      delegates.current.set(name, handler);
    }
    props[name] = handler;
  }
  const merged = mergeProps(
    props,
    own ? mergeProps(own, childProps) : childProps,
  ) as ElementProps;
  merged.ref = ref;

  return {
    live,
    /** Pass as Base UI trigger's `render` prop. */
    relay,
    element: cloneElement(child, merged),
  };
}

function TriggerRelay({
  props,
  deliver,
}: {
  props: ElementProps;
  deliver(props: ElementProps | null): void;
}) {
  useLayoutEffect(() => deliver(props));
  useLayoutEffect(() => () => deliver(null), [deliver]);
  return null;
}

function sameEntries(a: ElementProps, b: ElementProps) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is(a[key], b[key]))
  );
}
