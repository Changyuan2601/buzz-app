import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ResizeHandle } from "./ResizeHandle";
import styles from "./Panels.module.css";

// Each page owns its split; keep the preferred width while the dock is closed.
export function usePanelSplit(
  defaultWidth?: number,
  min = 316,
  primary?: { defaultWidth: number; maxRatio: number },
) {
  const ref = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState<number>();
  return {
    ref,
    style: undefined,
    handle: (
      <PanelSplitHandle
        target={ref}
        preferred={preferred}
        setPreferred={setPreferred}
        defaultWidth={defaultWidth}
        min={min}
        primary={primary}
      />
    ),
  };
}

// Container reflow updates the grip and CSS width, not the page and its messages.
function PanelSplitHandle({
  target: ref,
  preferred,
  setPreferred,
  defaultWidth,
  min,
  primary,
}: {
  target: RefObject<HTMLDivElement | null>;
  preferred: number | undefined;
  setPreferred(width: number | undefined): void;
  defaultWidth: number | undefined;
  min: number;
  primary: { defaultWidth: number; maxRatio: number } | undefined;
}) {
  const [available, setAvailable] = useState(0);
  const measured = useRef(false);
  // Read an existing container with the commit's other layout reads: by the
  // passive effect, later effects have written and the read forces a second
  // layout. A container mounting in this commit attaches its ref after this.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    measured.current = true;
    setAvailable(element.clientWidth);
  }, [ref]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    if (!measured.current) measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  const minimum = Math.max(min, available * (1 - (primary?.maxRatio ?? 1)));
  const max = Math.max(minimum, available - 320);
  const clamp = (width: number) => Math.min(max, Math.max(minimum, width));
  const width = clamp(
    preferred ??
      defaultWidth ??
      (primary ? available - primary.defaultWidth : available / 2.1),
  );
  const automatic = preferred === undefined && primary === undefined;
  useLayoutEffect(() => {
    if (!available) return;
    const style = ref.current?.style;
    if (automatic) style?.removeProperty("--secondary-panel-width");
    else style?.setProperty("--secondary-panel-width", `${width}px`);
  }, [ref, available, width, automatic]);
  return (
    <ResizeHandle
      label="Resize main and secondary panels"
      direction={-1}
      target={ref}
      property="--secondary-panel-width"
      width={width}
      min={minimum}
      max={max}
      setWidth={(next) => setPreferred(clamp(next))}
      reset={() => setPreferred(undefined)}
      className={styles.resize}
    />
  );
}
