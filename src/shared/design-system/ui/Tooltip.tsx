import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  cloneElement,
  useCallback,
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
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
  const trigger = useRef<HTMLElement | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const pressed = useRef(false);
  // Focus returning to a pressed trigger, such as when its menu closes, is not
  // a request for the hint. Base UI blocks this only once the hint has opened,
  // which a resting hover may not have done yet. Tabbing ends the press.
  // A callback ref follows the trigger node without re-rendering on mount.
  const attach = useCallback((node: HTMLElement | null) => {
    trigger.current = node;
    if (!node) return;
    const win = node.ownerDocument.defaultView ?? window;
    const release = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      pressed.current = false;
      win.removeEventListener("keydown", release, true);
    };
    const press = () => {
      pressed.current = true;
      win.addEventListener("keydown", release, true);
    };
    node.addEventListener("pointerdown", press);
    return () => {
      if (trigger.current === node) trigger.current = null;
      node.removeEventListener("pointerdown", press);
      win.removeEventListener("keydown", release, true);
    };
  }, []);
  const open = controlledOpen ?? localOpen;
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
      disableHoverablePopup={follow === "pointer" || disableHoverablePopup}
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
        <TooltipPositioner
          trigger={trigger}
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
        </TooltipPositioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/** Portal content renders after its trigger has committed, so the trigger's
 * pane is known by the time a hint is positioned. */
function TooltipPositioner({
  trigger,
  ...props
}: ComponentProps<typeof BaseTooltip.Positioner> & {
  trigger: RefObject<HTMLElement | null>;
}) {
  return (
    <BaseTooltip.Positioner
      // A host can keep hints inside its pane, including when a sibling
      // pane contains native content above the document's paint layer.
      collisionBoundary={
        trigger.current?.closest<HTMLElement>("[data-overlay-boundary]") ??
        undefined
      }
      {...props}
    />
  );
}
