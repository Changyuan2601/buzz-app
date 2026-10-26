import { useCallback, type RefObject } from "react";

/** An explicitly marked reader owns its composer and overlay placement. */
export type ComposerOverlayHost = Readonly<{
  composer: HTMLElement;
  pane: HTMLElement;
  container: HTMLElement;
}>;
export type MediaReviewOrigin = Readonly<{
  host: ComposerOverlayHost | null;
  rootId: string;
}>;
const hosts = new WeakMap<HTMLElement, ComposerOverlayHost>();

/** The renderer marks its reader boundary; styling never chooses ownership. */
export function overlayHostFor(
  origin: Element | null,
): ComposerOverlayHost | null {
  const pane = origin?.closest<HTMLElement>("[data-composer-host]");
  const host = pane && hosts.get(pane);
  return host?.composer.isConnected ? host : null;
}

export function registerOverlayComposer(composer: HTMLElement) {
  const pane = composer.closest<HTMLElement>("[data-composer-host]");
  if (!pane) return () => {};
  const host = {
    composer,
    pane,
    // Nested viewers share the outer layer, outside its filtered surface.
    container:
      pane.closest<HTMLElement>("[data-details-sheet]")?.parentElement ?? pane,
  };
  hosts.set(pane, host);
  return () => {
    if (hosts.get(pane) === host) hosts.delete(pane);
  };
}

export function useOverlayComposerRef(ref: RefObject<HTMLFormElement | null>) {
  return useCallback(
    (element: HTMLFormElement | null) => {
      ref.current = element;
      if (!element) return;
      const release = registerOverlayComposer(element);
      return () => {
        release();
        ref.current = null;
      };
    },
    [ref],
  );
}

/** Accepted local sends dismiss an agent details reader attached to this editor. */
export const COMPOSER_SENT = "message-composer-sent";
