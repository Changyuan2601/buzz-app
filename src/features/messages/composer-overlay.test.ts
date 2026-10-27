// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { overlayHostFor, registerOverlayComposer } from "./composer-overlay";

afterEach(() => document.body.replaceChildren());

it("opens nested details outside the sheet after a retained reader attaches, and follows it into a tab", () => {
  const reader = document.createElement("section");
  reader.dataset.composerHost = "";
  const composer = document.createElement("form");
  const trigger = document.createElement("button");
  reader.append(trigger, composer);
  // React registers the editor while its retained portal node is detached.
  const release = registerOverlayComposer(composer);
  try {
    expect(overlayHostFor(trigger)).toBeNull();
    const layer = document.createElement("div");
    layer.dataset.detailsSheet = "";
    const sheet = document.createElement("div");
    sheet.append(reader);
    layer.append(sheet);
    document.body.append(layer);
    const nested = overlayHostFor(trigger);
    expect(nested?.container).toBe(document.body);
    expect(nested?.composer).toBe(composer);
    expect(nested?.pane).toBe(reader);
    // Promotion moves the same reader; a later profile must not reuse the old layer.
    const tab = document.createElement("div");
    document.body.append(tab);
    tab.append(reader);
    expect(overlayHostFor(trigger)?.container).toBe(reader);
  } finally {
    release();
  }
  expect(overlayHostFor(trigger)).toBeNull();
});
