import { mergeProps } from "@base-ui/react/merge-props";
import { flushSync } from "react-dom";
import {
  cloneElement,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from "react";

type Intent = {
  pointer?: MouseEvent<HTMLElement> | undefined;
  focus?: FocusEvent<HTMLElement> | undefined;
};

type Forwarded = { keys: readonly string[]; props: Record<string, unknown> };

/** Handlers Base UI 1.9's hover triggers install; new ones are added on sight. */
const TRIGGER_HANDLERS = [
  "onBlur",
  "onClick",
  "onFocus",
  "onKeyDown",
  "onMouseEnter",
  "onMouseLeave",
  "onMouseMove",
  "onMouseOver",
  "onPointerDown",
  "onPointerEnter",
];

/**
 * Most hover popups are never asked for, but each Base UI Root and Trigger
 * costs a mount, store subscriptions and effects. Until the first pointer or
 * focus reaches the trigger, render only its element. On that first intent the
 * caller mounts its Root and Trigger with `render` and `replay`: the Trigger
 * forwards its props to the same element, so nothing remounts, and the intent
 * that armed it is handed to Base UI once its listeners are attached.
 *
 * A trigger that opens on a press instead, such as a context menu, arms within
 * that event and hands the same event to Base UI where its handler would run.
 */
export function useIntentTrigger({
  child,
  idle,
  own,
  force,
  hover = true,
  press,
}: {
  child: ReactElement;
  /** The attributes Base UI's trigger renders while closed. */
  idle: Record<string, unknown>;
  /** Props that take precedence over the child's, as a render element's do. */
  own?: Record<string, unknown>;
  /** Mount at once, for a controlled popup that is already open. */
  force: boolean;
  /** Whether pointer entry and focus arm the trigger. */
  hover?: boolean;
  /** Events that arm the trigger at once, when their predicate accepts them. */
  press?: Record<string, (event: SyntheticEvent) => boolean>;
}) {
  const host = useRef<HTMLElement | null>(null);
  const [armed, setArmed] = useState(force);
  if (force && !armed) setArmed(true);
  const intent = useRef<Intent>({});
  const sink = useRef<Record<string, unknown>>({});
  // Until Base UI's trigger reports, it renders exactly the idle attributes.
  const [forwarded, setForwarded] = useState<Forwarded>(() => {
    const keys = [
      ...new Set([...TRIGGER_HANDLERS, ...Object.keys(press ?? {})]),
    ];
    return { keys, props: forwardedProps(keys, idle, sink) };
  });
  const childRef = (child.props as { ref?: Ref<HTMLElement> }).ref;
  const hostRef = useCallback(
    (element: HTMLElement | null) => {
      host.current = element;
      return assignRef(childRef, element);
    },
    [childRef],
  );
  const point = (event: MouseEvent<HTMLElement>) => {
    if (armed) return;
    intent.current.pointer = event;
    // A pointer crossing, such as rows scrolling under a still pointer, must
    // not hold up a frame: the hint waits for the pointer to rest anyway.
    startTransition(() => setArmed(true));
  };
  const leave = () => {
    intent.current.pointer = undefined;
  };
  const hoverHandlers = {
    onPointerEnter: point,
    onMouseEnter: point,
    onMouseMove: point,
    onPointerLeave: leave,
    onMouseLeave: leave,
    onFocus(event: FocusEvent<HTMLElement>) {
      if (armed) return;
      intent.current.focus = event;
      setArmed(true);
    },
    onBlur() {
      intent.current.focus = undefined;
    },
    // A press before Base UI mounted cancels the pending hover open, as
    // Base UI's own trigger does.
    onPointerDown() {
      intent.current.pointer = undefined;
    },
  };
  const dormant: Record<string, unknown> = { ...idle };
  for (const [key, accepts] of Object.entries(press ?? {}))
    dormant[key] = (event: SyntheticEvent) => {
      if (!accepts(event)) return;
      flushSync(() => setArmed(true));
      (sink.current[key] as ((event: SyntheticEvent) => void) | undefined)?.(
        event,
      );
    };
  // Base UI merges render-element props last, so the child's own handlers run
  // first, and these intent handlers run before both and never stop them.
  // Press handlers stand where Base UI's would, after the child's.
  const element = cloneElement(
    child,
    mergeProps(
      armed ? forwarded.props : dormant,
      child.props as Record<string, unknown>,
      own,
      hover ? { ref: hostRef, ...hoverHandlers } : { ref: hostRef },
    ),
  );
  return {
    armed,
    host,
    element,
    render: (props: unknown) => (
      <TriggerBridge
        props={props as Record<string, unknown>}
        host={host}
        sink={sink}
        forwarded={forwarded}
        onForward={setForwarded}
      />
    ),
    replay: <IntentReplay host={host} intent={intent} props={sink} />,
  };
}

function forwardedProps(
  keys: readonly string[],
  attributes: Record<string, unknown>,
  sink: RefObject<Record<string, unknown>>,
) {
  const props: Record<string, unknown> = { ...attributes };
  for (const key of keys)
    props[key] = (event: SyntheticEvent) =>
      (sink.current[key] as ((event: SyntheticEvent) => void) | undefined)?.(
        event,
      );
  return props;
}

function isHandler(key: string, value: unknown) {
  return /^on[A-Z]/.test(key) && typeof value === "function";
}

/**
 * Base UI's trigger renders this instead of an element. The caller already
 * renders the trigger element, so the props Base UI computed are forwarded to
 * it without replacing the element the pointer or focus is on.
 */
function TriggerBridge({
  props,
  host,
  sink,
  forwarded,
  onForward,
}: {
  props: Record<string, unknown>;
  host: RefObject<HTMLElement | null>;
  sink: RefObject<Record<string, unknown>>;
  forwarded: Forwarded;
  onForward(next: Forwarded): void;
}) {
  const ref = props.ref as Ref<HTMLElement> | undefined;
  useLayoutEffect(() => {
    sink.current = props;
    const attributes: Record<string, unknown> = {};
    const keys = [...forwarded.keys];
    for (const [key, value] of Object.entries(props)) {
      if (key === "ref") continue;
      if (isHandler(key, value)) {
        if (!keys.includes(key)) keys.push(key);
      } else attributes[key] = value;
    }
    const previous = Object.fromEntries(
      Object.entries(forwarded.props).filter(([key]) => !keys.includes(key)),
    );
    const changed =
      keys.length !== forwarded.keys.length ||
      Object.keys({ ...previous, ...attributes }).some(
        (key) => !sameValue(previous[key], attributes[key]),
      );
    if (changed)
      onForward({ keys, props: forwardedProps(keys, attributes, sink) });
  });
  useLayoutEffect(() => {
    const cleanup = assignRef(ref, host.current);
    return () => {
      if (typeof cleanup === "function") cleanup();
      else assignRef(ref, null);
    };
  }, [ref, host]);
  return null;
}

/**
 * Hand the intent that armed the popup to Base UI once its listeners are
 * attached: Base UI's own effects run before this later sibling's.
 */
function IntentReplay({
  host,
  intent,
  props,
}: {
  host: RefObject<HTMLElement | null>;
  intent: RefObject<Intent>;
  props: RefObject<Record<string, unknown>>;
}) {
  useEffect(() => {
    queueMicrotask(() => {
      const element = host.current;
      const { pointer, focus } = intent.current;
      intent.current = {};
      if (!element) return;
      const call = (key: string, event: SyntheticEvent) =>
        (props.current[key] as ((event: SyntheticEvent) => void) | undefined)?.(
          Object.assign(Object.create(event) as SyntheticEvent, {
            currentTarget: element,
          }),
        );
      if (pointer) {
        call("onPointerEnter", pointer);
        call("onMouseEnter", pointer);
        element.dispatchEvent(
          new globalThis.MouseEvent("mouseenter", {
            clientX: pointer.clientX,
            clientY: pointer.clientY,
          }),
        );
        call("onMouseMove", pointer);
      }
      if (focus) call("onFocus", focus);
    });
  }, [host, intent, props]);
  return null;
}

/** Style objects are rebuilt each render; compare them by entries. */
function sameValue(a: unknown, b: unknown) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const entries = Object.entries(a);
  return (
    entries.length === Object.keys(b).length &&
    entries.every(
      ([key, value]) => (b as Record<string, unknown>)[key] === value,
    )
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") return ref(value);
  if (ref) (ref as { current: T | null }).current = value;
}
