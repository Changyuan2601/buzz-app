import { expect } from "./playwright-test.mjs";

/** Both a closed toolbar and a hidden, anchored toolbar must neither paint nor hit. */
export const expectMessageActionsHidden = (actions) =>
  expect
    .poll(() =>
      actions.evaluate((bar) => {
        const style = getComputedStyle(bar);
        const rect = bar.getBoundingClientRect();
        return {
          painted:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0,
          takesPointer: bar.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          ),
        };
      }),
    )
    .toEqual({ painted: false, takesPointer: false });

/** Reveal actions from visible message content, never its full-width row. */
export const hoverMessage = (row) =>
  row
    .locator("[data-message-action-anchor], [data-message-attachments] > *")
    .first()
    .hover();
