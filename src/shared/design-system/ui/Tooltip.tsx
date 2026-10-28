import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { FAMILIAR_HINT_REST_MS, HELPFUL_HINT_REST_MS } from "./hoverIntent";

/** DESIGN.md "Hover timing": how long a hint waits for a resting pointer. */
export type HintTiming = "helpful" | "familiar";

/** Hints in one provider open instantly while a neighbor is showing. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider>{children}</BaseTooltip.Provider>;
}

/** A short supplementary hint. The trigger still owns its accessible name. */
export function Tooltip({
  children,
  content,
  hint = "helpful",
  closeOnClick = true,
  disableHoverablePopup = false,
  side = "top",
  follow = "trigger",
  open: controlledOpen,
  onOpenChange,
}: {
  children: ReactElement<
    Pick<AriaAttributes, "aria-describedby" | "aria-expanded"> & {
      "data-accent"?: string;
      "data-color-mode"?: string;
    }
  >;
  content: ReactNode;
  hint?: HintTiming | undefined;
  closeOnClick?: boolean;
  disableHoverablePopup?: boolean;
  side?: "top" | "right";
  /** Attach a non-interactive hint below/right of the native pointer. */
  follow?: "trigger" | "pointer";
  /** Action feedback may open a hint after an asynchronous result. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const id = useId();
  // A ref, not state: storing the element re-rendered every new trigger once.
  const trigger = useRef<HTMLElement | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const pressed = useRef(false);
  const releasePress = useRef<(() => void) | null>(null);
  useEffect(() => () => releasePress.current?.(), []);
  // Focus returning to a pressed trigger, such as when its menu closes, is not
  // a request for the hint. Base UI blocks this only once the hint has opened,
  // which a resting hover may not have done yet. Tabbing ends the press.
  const attach = useCallback((element: HTMLElement | null) => {
    trigger.current = element;
    if (!element) return;
    const press = () => {
      pressed.current = true;
      if (releasePress.current) return;
      const win = element.ownerDocument.defaultView ?? window;
      const release = (event: KeyboardEvent) => {
        if (event.key !== "Tab") return;
        pressed.current = false;
        stop();
      };
      const stop = () => {
        win.removeEventListener("keydown", release, true);
        releasePress.current = null;
      };
      win.addEventListener("keydown", release, true);
      releasePress.current = stop;
    };
    element.addEventListener("pointerdown", press);
    return () => {
      element.removeEventListener("pointerdown", press);
      if (trigger.current === element) trigger.current = null;
    };
  }, []);
  const open = controlledOpen ?? localOpen;
  // Base UI syncs disableHoverablePopup into a store that starts false, so a
  // `true` from mount re-renders every new trigger once. It has no effect until
  // the hint first opens (there is no popup to hover), so latch it from then on.
  const [opened, setOpened] = useState(false);
  if (open && !opened) setOpened(true);
  const nonHoverable = follow === "pointer" || disableHoverablePopup;
  const expanded =
    children.props["aria-expanded"] === true ||
    children.props["aria-expanded"] === "true";
  const describedBy =
    [children.props["aria-describedby"], open && !expanded ? id : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <BaseTooltip.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next && details.reason === "trigger-focus" && pressed.current) {
          details.cancel();
          return;
        }
        setLocalOpen(next);
        onOpenChange?.(next);
      }}
      disabled={expanded}
      disableHoverablePopup={nonHoverable && opened}
      trackCursorAxis={follow === "pointer" ? "both" : "none"}
    >
      <BaseTooltip.Trigger
        ref={attach}
        delay={
          hint === "familiar" ? FAMILIAR_HINT_REST_MS : HELPFUL_HINT_REST_MS
        }
        closeOnClick={closeOnClick}
        // Base UI merges render-element props last. Put the combined link on
        // that element so its original description cannot replace the hint.
        render={cloneElement(children, { "aria-describedby": describedBy })}
      />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          // A host can keep hints inside its pane, including when a sibling
          // pane contains native content above the document's paint layer.
          // Mounted only after the hint opens, which renders after attachment.
          collisionBoundary={
            trigger.current?.closest<HTMLElement>("[data-overlay-boundary]") ??
            undefined
          }
          side={follow === "pointer" ? "bottom" : side}
          align={follow === "pointer" ? "start" : "center"}
          // Clear the physical pointer silhouette; these offsets are not layout spacing.
          sideOffset={follow === "pointer" ? 18 : 4}
          alignOffset={follow === "pointer" ? 10 : 0}
          // Fixed hints never add page scroll width, even while WebKit keeps
          // one open across a resize.
          positionMethod="fixed"
          className="buzz-tooltip-positioner"
        >
          <BaseTooltip.Popup
            role="tooltip"
            id={id}
            data-buzz-ui=""
            data-accent={children.props["data-accent"]}
            data-color-mode={children.props["data-color-mode"]}
            className="buzz-tooltip"
            data-follow={follow}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
