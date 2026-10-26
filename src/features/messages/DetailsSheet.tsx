import { spring } from "motion";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { XIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useFinalFocusUnlessMoved } from "../../shared/design-system/ui/finalFocus";
import styles from "./DetailsSheet.module.css";
import messageStyles from "./Messages.module.css";

/** What a composer dispatches on itself when it accepts a message to send,
 * which closes a details reader grown out of it: the reply is written. */
export const COMPOSER_SENT = "message-composer-sent";

/** The composer a message's details grow out of: the nearest one sharing its
 * conversation, so a thread's details rise from the thread's composer. */
export function composerFor(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const composer = node.querySelector<HTMLElement>("[data-message-composer]");
    if (composer) return composer;
  }
  return null;
}

/** The rounded panel the conversation sits in, which the scrim dims. */
function paneOf(composer: HTMLElement): HTMLElement {
  for (let node = composer.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflow !== "visible" && style.borderTopLeftRadius !== "0px")
      return node;
  }
  return composer.parentElement ?? composer;
}

/** Where the sheet sits: around its composer, within the composer's pane. */
function geometry(composer: HTMLElement): CSSProperties {
  const rect = composer.getBoundingClientRect();
  const pane = paneOf(composer);
  const bounds = pane.getBoundingClientRect();
  return {
    "--composer-left": `${rect.left}px`,
    "--composer-width": `${rect.width}px`,
    "--composer-height": `${rect.height}px`,
    "--composer-bottom": `${window.innerHeight - rect.bottom}px`,
    "--composer-radius": getComputedStyle(composer).borderTopLeftRadius,
    "--pane-top": `${bounds.top}px`,
    "--pane-left": `${bounds.left}px`,
    "--pane-width": `${bounds.width}px`,
    "--pane-height": `${bounds.height}px`,
    "--pane-radius": getComputedStyle(pane).borderRadius,
  } as CSSProperties;
}

/** Follows the composer while the sheet is mounted: it grows as a reply is
 * typed, and the pane resizes with the window and its splits. */
function useComposerGeometry(composer: HTMLElement, mounted: boolean) {
  const [style, setStyle] = useState(() => geometry(composer));
  useLayoutEffect(() => {
    if (!mounted) return;
    const update = () => setStyle(geometry(composer));
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(composer);
    if (composer.parentElement) observer?.observe(composer.parentElement);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [composer, mounted]);
  return style;
}

const immediate = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.hasAttribute("data-keyboard-navigation");

/** Motion tokens, read where the sheet paints so scaled themes agree. */
function token(element: Element, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}
const milliseconds = (value: string) =>
  value.endsWith("ms")
    ? Number.parseFloat(value)
    : Number.parseFloat(value) * 1000;

/** Grows the sheet up out of the composer as it opens and folds it back down
 * into the composer as it closes. Base UI waits for these animations before it
 * unmounts the sheet. Returns the callback that starts the motion. */
function useGrowth() {
  const last = useRef<{ open: boolean; animation?: Animation }>(undefined);
  return (element: HTMLElement, open: boolean, mounting = false) => {
    if (mounting) last.current = undefined;
    const previous = last.current;
    if (previous?.open === open) return;
    // Keep layout at its final size: only the reveal mask and a small elastic
    // stretch move. In particular, the bottom editor never gets squeezed out.
    const painted = getComputedStyle(element);
    const shownClip = painted.clipPath;
    const shownTransform = painted.transform;
    previous?.animation?.cancel();
    last.current = { open };
    if (typeof element.animate !== "function" || immediate()) return;
    const radius = painted.borderRadius;
    const composerHeight =
      Number.parseFloat(token(element, "--composer-height", "0px")) +
      2 * Number.parseFloat(token(element, "--sheet-gap", "8px"));
    const folded = Math.max(0, element.offsetHeight - composerHeight);
    const mask = (top: number | string) =>
      `inset(${typeof top === "number" ? `${top}px` : top} 0 0 round ${radius})`;
    const duration = milliseconds(
      token(
        element,
        open ? "--duration-settle" : "--duration-fast",
        open ? "220ms" : "150ms",
      ),
    );
    const from = previous
      ? Number.parseFloat(shownClip.match(/inset\(([-\d.]+)px/)?.[1] ?? "0")
      : folded;
    const settle = spring({ keyframes: [0, 1], duration, bounce: 0.08 });
    const frames: Keyframe[] = open
      ? Array.from({ length: 25 }, (_, index) => {
          const offset = index / 24;
          const progress = settle.next(offset * duration).value;
          const stretch = Math.max(0, progress - 1) * 0.3;
          return {
            offset,
            // Content can mount after the popup ref. A relative mask follows
            // that height instead of freezing the initial loading placeholder.
            clipPath: mask(
              previous
                ? Math.max(0, from * (1 - progress))
                : `max(0px, calc(${Math.max(0, 1 - progress) * 100}% - ${Math.max(0, 1 - progress) * composerHeight}px))`,
            ),
            transform:
              index === 0 && previous
                ? shownTransform
                : `scale(${1 - stretch * 0.4}, ${1 + stretch})`,
          };
        })
      : [
          {
            clipPath: shownClip === "none" ? mask(0) : shownClip,
            transform: shownTransform,
          },
          { clipPath: mask(folded), transform: "none" },
        ];
    last.current.animation = element.animate(frames, {
      duration,
      easing: open
        ? "linear"
        : token(element, "--easing-enter", "cubic-bezier(0.23, 1, 0.32, 1)"),
      fill: open ? "none" : "forwards",
    });
  };
}

/** Match the two real editors without moving their focus, draft, or DOM ownership. */
function useComposerHandoff(
  sheet: HTMLElement | null,
  source: HTMLElement,
  open: boolean,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    if (!sheet || !enabled) return;
    let animations: Animation[] = [];
    let started = false;
    const start = () => {
      const target = sheet.querySelector<HTMLElement>(
        "[data-message-composer]",
      );
      if (!target || started) return;
      started = true;
      if (immediate() || typeof target.animate !== "function") {
        if (open) {
          sheet.dataset.composerReady = "";
          source.dataset.composerCovered = "";
        }
        return;
      }
      const first = source.getBoundingClientRect();
      const last = target.getBoundingClientRect();
      if (!first.width || !last.width || !first.height || !last.height) return;
      const matched = `translate(${first.x - last.x}px, ${first.y - last.y}px) scale(${first.width / last.width}, ${first.height / last.height})`;
      const options: KeyframeAnimationOptions = {
        duration: milliseconds(
          token(sheet, open ? "--duration-settle" : "--duration-fast", "220ms"),
        ),
        easing: token(
          sheet,
          "--easing-enter",
          "cubic-bezier(0.23, 1, 0.32, 1)",
        ),
        fill: "both",
      };
      const frames = [
        { transform: matched, transformOrigin: "top left", opacity: 0 },
        { transform: "none", transformOrigin: "top left", opacity: 1 },
      ];
      const incoming = target.animate(
        open ? frames : [...frames].reverse(),
        options,
      );
      const outgoing = source.animate(
        [{ opacity: open ? 1 : 0 }, { opacity: open ? 0 : 1 }],
        options,
      );
      animations = [incoming, outgoing];
      incoming.onfinish = () => {
        if (open) {
          sheet.dataset.composerReady = "";
          source.dataset.composerCovered = "";
          animations.forEach((animation) => {
            animation.cancel();
          });
        }
      };
    };
    start();
    // Media/thread editors arrive after their verified root, independently of
    // the sheet's render. Observe only this popup and animate once per opening.
    const observer = new MutationObserver(start);
    if (!started) observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      animations.forEach((animation) => {
        animation.cancel();
      });
      delete sheet.dataset.composerReady;
      delete source.dataset.composerCovered;
    };
  }, [sheet, source, open, enabled]);
}

/** A details reader that rises out of the conversation's composer, which stays
 * in place below it so a reply can be written while reading. It uses the
 * medium dialog's insets, with its title and Close on one row. */
export function DetailsSheet({
  open,
  onOpenChange,
  composer,
  title,
  description,
  leading,
  closeLabel = "Close",
  finalFocus,
  children,
  containsComposer = false,
  height = "content",
  headerActions,
  onClosed,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  composer: HTMLElement;
  title: ReactNode;
  description?: ReactNode;
  /** Shown before the title, such as its author's avatar. */
  leading?: ReactNode;
  closeLabel?: string;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
  /** Thread/media content supplies its own correctly scoped composer. */
  containsComposer?: boolean;
  /** Media stages need a bounded working area; threads hug their contents. */
  height?: "content" | "stable";
  headerActions?: ReactNode;
  onClosed?: () => void;
}) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const style = useComposerGeometry(composer, mounted);
  useLayoutEffect(() => {
    if (!mounted || !containsComposer) return;
    const inert = composer.inert;
    composer.inert = true;
    return () => {
      composer.inert = inert;
    };
  }, [composer, mounted, containsComposer]);
  const popup = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  useComposerHandoff(surface, composer, open, containsComposer);
  const grown = useRef<HTMLDivElement | null>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const grow = useGrowth();
  // The portal mounts the popup after this effect on first open; its ref
  // starts that growth. Later changes reverse whatever motion is running.
  useLayoutEffect(() => {
    if (popup.current) grow(popup.current, open);
  });
  useEffect(() => {
    if (!open || containsComposer) return;
    const close = () => onOpenChange(false);
    composer.addEventListener(COMPOSER_SENT, close);
    return () => composer.removeEventListener(COMPOSER_SENT, close);
  }, [composer, open, onOpenChange, containsComposer]);
  return (
    <BaseDialog.Root
      open={open}
      // The composer below stays live: reading does not block a reply.
      modal={containsComposer}
      onOpenChange={(next, details) => {
        if (!next) {
          const target =
            details.event instanceof FocusEvent
              ? details.event.relatedTarget
              : details.event?.target;
          // Writing a reply is part of reading, not leaving it.
          if (
            (details.reason === "outside-press" ||
              details.reason === "focus-out") &&
            target instanceof Node &&
            !containsComposer &&
            composer.contains(target)
          ) {
            details.cancel();
            return;
          }
          // Only a press, Escape or Close dismisses it, never moving focus.
          if (details.reason === "focus-out") {
            details.cancel();
            return;
          }
        }
        onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        setMounted(false);
        onClosed?.();
        // Once focus has visited the composer, Base UI returns none and Close
        // would leave it on the page; hand it back to the opener instead.
        const active = document.activeElement;
        if (active === document.body || popup.current?.contains(active))
          finalFocus?.current?.focus({ preventScroll: true });
      }}
    >
      <BaseDialog.Portal
        container={
          composer.closest("[data-details-sheet]")?.parentElement ??
          composer.parentElement
        }
        className={messageStyles.detailsSheetLayer}
        data-details-sheet=""
      >
        <BaseDialog.Backdrop
          forceRender
          className={styles.scrim}
          style={style}
        />
        <BaseDialog.Popup
          ref={(element) => {
            // React reattaches this callback each render; grow once per mount.
            if (element && element !== grown.current) {
              grown.current = element;
              setSurface(element);
              grow(element, true, true);
            }
            popup.current = element;
            focus.ref(element);
          }}
          className={styles.sheet}
          data-contained-composer={containsComposer || undefined}
          data-height={height}
          style={style}
          finalFocus={focus.finalFocus}
        >
          <div className={styles.content}>
            {/* One row: who wrote it and when, with Close at its end. */}
            <header className={`buzz-dialog-header ${styles.header}`}>
              <div className={styles.byline}>
                {leading}
                <BaseDialog.Title className={`text-label ${styles.name}`}>
                  {title}
                </BaseDialog.Title>
                {description && (
                  <BaseDialog.Description
                    className={`buzz-dialog-description ${styles.time}`}
                  >
                    {description}
                  </BaseDialog.Description>
                )}
              </div>
              <div className="buzz-dialog-header-actions">
                {headerActions}
                <BaseDialog.Close
                  render={
                    <IconButton
                      aria-label={closeLabel}
                      variant="glass"
                      shape="round"
                      size="compact"
                      icon={<XIcon size={16} aria-hidden="true" />}
                    />
                  }
                />
              </div>
            </header>
            <div className={`buzz-dialog-body ${styles.body}`}>{children}</div>
          </div>
          {/* The composer shows through here, inside the sheet's ring. */}
          {!containsComposer && (
            <div className={styles.composerSpace} aria-hidden="true" />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
