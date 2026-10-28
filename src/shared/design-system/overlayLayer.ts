const unavailable = '[hidden], [inert], [aria-hidden="true"]';

/**
 * Native top-layer hover surfaces paint above ordinary portals regardless of
 * z-index. Reuse popup semantics and Base UI's rendered lifetime, not a second
 * overlay registry. Inline lists, toasts and supplemental previews aren't popups.
 */
export function behindActiveOverlay(element: Element) {
  const document = element.ownerDocument;
  const modal = [
    ...document.querySelectorAll('[aria-modal="true"], dialog[open]'),
  ]
    .filter((candidate) => !candidate.closest(unavailable))
    .at(-1);
  if (modal && !modal.contains(element)) return true;

  const triggers = [
    ...document.querySelectorAll("[aria-haspopup][aria-controls]"),
  ];
  return [
    ...document.querySelectorAll(
      '[role="menu"], [role="listbox"], [role="dialog"]',
    ),
  ].some((popup) => {
    if (
      popup.contains(element) ||
      popup.closest(`${unavailable}, [popover="manual"]`)
    )
      return false;
    const portal = popup.closest("[data-base-ui-portal]");
    // Nested Base UI portals stay in their parent's portal. Allow a preview
    // inside the active interaction, not a background preview over its menu.
    if (portal?.contains(element)) return false;
    // A Select's listbox lives inside its presentation popup. Don't mistake an
    // inline list inside a larger dialog for another overlay.
    const surface = popup.closest("[data-open]");
    const positioned =
      surface === popup || surface?.getAttribute("role") === "presentation";
    // Base UI marks interactive popups open; closing surfaces no longer own
    // interaction or focus. Custom completions expose an accessible owner link.
    return (
      !!(portal && positioned) ||
      triggers.some(
        (trigger) =>
          popup.id &&
          trigger.getAttribute("aria-expanded") !== "false" &&
          trigger
            .getAttribute("aria-controls")
            ?.split(/\s+/)
            .includes(popup.id),
      )
    );
  });
}

/** Everything behindActiveOverlay and owned-popup checks read from the tree. */
const overlayParts =
  '[aria-modal="true"], dialog[open], [role="menu"], [role="listbox"], [role="dialog"], [aria-haspopup][aria-controls], [aria-haspopup][aria-expanded="true"]';
const changesOverlays = (record: MutationRecord) =>
  record.type === "attributes" ||
  [...record.addedNodes, ...record.removedNodes].some(
    (node) =>
      node instanceof Element &&
      (node.matches(overlayParts) || !!node.querySelector(overlayParts)),
  );

/** Open/close need not move focus or the pointer; watch the existing DOM state.
 * Inserting or removing ordinary content cannot change an overlay, so those
 * batches skip `update` and reach only `mutated`. */
export function observeOverlays(update: () => void, mutated?: () => void) {
  const observer = new MutationObserver((records) => {
    if (records.some(changesOverlays)) update();
    mutated?.();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "aria-modal",
      "aria-hidden",
      "inert",
      "hidden",
      "open",
      "aria-expanded",
      "aria-haspopup",
      "aria-controls",
      "data-open",
      "data-closed",
    ],
  });
  return () => observer.disconnect();
}
