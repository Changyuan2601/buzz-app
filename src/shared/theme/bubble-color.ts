import type { CSSProperties } from "react";

// The six message colors selected from the designer's reference.
export const BUBBLE_COLORS = [
  "neutral",
  "blue",
  "green",
  "orange",
  "pink",
  "lilac",
] as const;
export type BubbleColor = (typeof BUBBLE_COLORS)[number];
export const BUBBLE_COLOR_KEY = "buzz-bubble-color.v1";
export function parseBubbleColor(value: unknown): BubbleColor {
  // Keep existing device preferences usable after narrowing the palette.
  if (value === "cyan" || value === "indigo") return "blue";
  if (value === "red") return "pink";
  if (value === "purple") return "lilac";
  return BUBBLE_COLORS.includes(value as BubbleColor)
    ? (value as BubbleColor)
    : "neutral";
}

// Scope the existing prominent-button recipe to this message action only.
export const messageButtonStyle = {
  "--affordance-prominent": "var(--surface-message-action)",
  "--affordance-prominent-hover": "var(--surface-message-action-hover)",
  "--affordance-prominent-pressed": "var(--surface-message-action-pressed)",
  "--text-inverse": "var(--text-message-action)",
} as CSSProperties;
