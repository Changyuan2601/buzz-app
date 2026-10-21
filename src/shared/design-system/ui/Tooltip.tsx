import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  cloneElement,
  useId,
  useState,
  type AriaAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

/** A short supplementary hint. The trigger still owns its accessible name. */
export function Tooltip({
  children,
  content,
  delay = 0,
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
  delay?: number;
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
  const [localOpen, setLocalOpen] = useState(false);
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
      onOpenChange={(next) => {
        setLocalOpen(next);
        onOpenChange?.(next);
      }}
      disabled={expanded}
      disableHoverablePopup={follow === "pointer" || disableHoverablePopup}
      trackCursorAxis={follow === "pointer" ? "both" : "none"}
    >
      <BaseTooltip.Trigger
        delay={delay}
        closeOnClick={closeOnClick}
        // Base UI merges render-element props last. Put the combined link on
        // that element so its original description cannot replace the hint.
        render={cloneElement(children, { "aria-describedby": describedBy })}
      />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
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
