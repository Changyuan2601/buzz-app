import { expect, it } from "vitest";
import { formatBinding, isApplePlatform } from "./format";

it("uses the dispatcher's platform test", () => {
  expect(isApplePlatform("MacIntel")).toBe(true);
  expect(isApplePlatform("iPhone")).toBe(true);
  expect(isApplePlatform("Linux x86_64")).toBe(false);
  expect(isApplePlatform("Win32")).toBe(false);
  expect(isApplePlatform("")).toBe(false);
});

it("renders glyphs in Control, Option, Shift, Command order on Apple platforms", () => {
  expect(formatBinding({ key: "k", mod: true, shift: true }, true)).toEqual({
    parts: ["⇧", "⌘", "K"],
    text: "⇧⌘K",
    label: "Shift Command K",
  });
  expect(
    formatBinding({ key: "k", mod: true, shift: true, alt: true }, true).text,
  ).toBe("⌥⇧⌘K");
  expect(formatBinding({ key: "a", mod: true, ctrl: true }, true)).toEqual({
    parts: ["⌃", "⌘", "A"],
    text: "⌃⌘A",
    label: "Control Command A",
  });
  expect(formatBinding({ key: ",", mod: true }, true)).toEqual({
    parts: ["⌘", ","],
    text: "⌘,",
    label: "Command ,",
  });
  expect(formatBinding({ key: "ArrowLeft", alt: true }, true)).toEqual({
    parts: ["⌥", "←"],
    text: "⌥←",
    label: "Option Left Arrow",
  });
});

it("renders words joined by plus signs elsewhere", () => {
  expect(formatBinding({ key: "k", mod: true, shift: true }, false)).toEqual({
    parts: ["Ctrl", "Shift", "K"],
    text: "Ctrl+Shift+K",
    label: "Control Shift K",
  });
  expect(
    formatBinding({ key: "k", mod: true, shift: true, alt: true }, false).text,
  ).toBe("Ctrl+Alt+Shift+K");
  expect(formatBinding({ key: "ArrowRight", alt: true }, false)).toEqual({
    parts: ["Alt", "→"],
    text: "Alt+→",
    label: "Alt Right Arrow",
  });
});

it("names special keys readably and leaves symbols alone", () => {
  expect(formatBinding({ key: " ", mod: true }, true).text).toBe("⌘Space");
  expect(formatBinding({ key: "Enter", mod: true }, false).text).toBe(
    "Ctrl+Enter",
  );
  expect(formatBinding({ key: "Escape" }, true).text).toBe("Escape");
  expect(formatBinding({ key: "PageUp", mod: true }, true)).toEqual({
    parts: ["⌘", "PageUp"],
    text: "⌘PageUp",
    label: "Command Page Up",
  });
  expect(formatBinding({ key: "=", mod: true }, false).text).toBe("Ctrl+=");
  expect(formatBinding({ key: "+", mod: true, shift: true }, true).text).toBe(
    "⇧⌘+",
  );
  // Registered keys are matched case-insensitively; display is always uppercase.
  expect(formatBinding({ key: "K", mod: true }, true).label).toBe("Command K");
});
