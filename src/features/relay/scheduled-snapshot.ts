import { useEffect, useRef, useState } from "react";

/** Like useSyncExternalStore, but a published change renders in its own
 * scheduler task instead of the publisher's: a page's store commit and the
 * render of its rows become two tasks rather than one long one. A new store,
 * or a change missed before subscribing, renders synchronously. */
export function useScheduledSnapshot<T>(
  subscribe: (listener: () => void) => () => void,
  read: () => T,
): T {
  const [state, setState] = useState(() => ({ subscribe, value: read() }));
  const value = state.subscribe === subscribe ? state.value : read();
  const rendered = useRef(value);
  rendered.current = value;
  useEffect(() => {
    const next = () => ({ subscribe, value: read() });
    if (read() !== rendered.current) setState(next());
    return subscribe(() => setState(next()));
  }, [subscribe, read]);
  return value;
}
