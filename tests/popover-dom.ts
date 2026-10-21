import { afterEach, beforeEach } from "vitest";

// jsdom hides native popovers but cannot open them. Model visibility for DOM
// assertions; browser tests own top-layer painting and overlay precedence.
let showPopover: PropertyDescriptor | undefined;
beforeEach(() => {
  showPopover = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "showPopover",
  );
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value(this: HTMLElement) {
      this.style.display = "block";
    },
  });
});
afterEach(() => {
  if (showPopover)
    Object.defineProperty(HTMLElement.prototype, "showPopover", showPopover);
  else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});
