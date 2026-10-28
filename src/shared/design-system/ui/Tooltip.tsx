import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  useId,
  useEffect,
  useRef,
  useState,
  type AriaAttributes,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { FAMILIAR_HINT_REST_MS, HELPFUL_HINT_REST_MS } from "./hoverIntent";
import { useIntentTrigger } from "./intentTrigger";

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
  const triggerId = `base-ui-${useId()}`;
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const pressed = useRef(false);
  const releasePress = useRef<(() => void) | null>(null);
  useEffect(() => () => releasePress.current?.(), []);
  // Focus returning to a pressed trigger, such as when its menu closes, is not
  // a request for the hint. Base UI blocks this only once the hint has opened,
  // which a resting hover may not have done yet. Tabbing ends the press.
  const press = (event: PointerEvent<HTMLElement>) => {
    pressed.current = true;
    if (releasePress.current) return;
    const win = event.currentTarget.ownerDocument.defaultView ?? window;
    const release = (key: KeyboardEvent) => {
      if (key.key !== "Tab") return;
      pressed.current = false;
      releasePress.current?.();
    };
    win.addEventListener("keydown", release, true);
    releasePress.current = () => {
      win.removeEventListener("keydown", release, true);
      releasePress.current = null;
    };
  };
  const open = controlledOpen ?? localOpen;
  const expanded =
    children.props["aria-expanded"] === true ||
    children.props["aria-expanded"] === "true";
  const describedBy =
    [children.props["aria-describedby"], open && !expanded ? id : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  const { armed, element, render, replay } = useIntentTrigger({
    child: children,
    idle: {
      id: triggerId,
      [expanded ? "data-trigger-disabled" : "data-base-ui-tooltip-trigger"]: "",
    },
    // The combined link must stay on the element, so the original description
    // cannot replace the hint.
    own: { "aria-describedby": describedBy, onPointerDown: press },
    force: controlledOpen === true,
  });
  if (!armed) return element;
  const popup = (
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
      disableHoverablePopup={follow === "pointer" || disableHoverablePopup}
      trackCursorAxis={follow === "pointer" ? "both" : "none"}
    >
      <BaseTooltip.Trigger
        ref={setTrigger}
        id={triggerId}
        delay={
          hint === "familiar" ? FAMILIAR_HINT_REST_MS : HELPFUL_HINT_REST_MS
        }
        closeOnClick={closeOnClick}
        render={render}
      />
      {replay}
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          // A host can keep hints inside its pane, including when a sibling
          // pane contains native content above the document's paint layer.
          collisionBoundary={
            trigger?.closest<HTMLElement>("[data-overlay-boundary]") ??
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
  return (
    <>
      {element}
      {popup}
    </>
  );
}
