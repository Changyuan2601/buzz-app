import type { CSSProperties } from "react";

// One device-local accent family; the vibe level decides how much it paints.
// Chartreuse is the brand default; the vibe level decides how much it paints.
export const ACCENTS = [
  "chartreuse",
  "flame",
  "magenta",
  "iris",
  "cobalt",
  "jade",
] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "chartreuse";
export const ACCENT_KEY = "buzz-accent.v1";
/** The former message-bubble preference; read once when no accent is saved. */
export const LEGACY_BUBBLE_KEY = "buzz-bubble-color.v1";

export function parseAccent(value: unknown): Accent {
  return ACCENTS.includes(value as Accent) ? (value as Accent) : DEFAULT_ACCENT;
}

/** A saved bubble color carries over to its accent; its old "Default" does not. */
const LEGACY_BUBBLE_ACCENTS: Readonly<Record<string, Accent>> = {
  blue: "cobalt",
  cyan: "cobalt",
  indigo: "cobalt",
  green: "jade",
  orange: "flame",
  pink: "magenta",
  red: "magenta",
  lilac: "iris",
  purple: "iris",
};
export function parseLegacyBubbleColor(value: unknown): Accent {
  return (
    (typeof value === "string" ? LEGACY_BUBBLE_ACCENTS[value] : undefined) ??
    DEFAULT_ACCENT
  );
}

/** How much of the app the accent colors, from neutral to full. */
export const COLOR_LEVELS = ["neutral", "touch", "more", "full"] as const;
export type ColorLevel = (typeof COLOR_LEVELS)[number];
export const DEFAULT_COLOR_LEVEL: ColorLevel = "touch";
export const COLOR_LEVEL_KEY = "buzz-color-level.v1";
export const parseColorLevel = (value: unknown): ColorLevel =>
  COLOR_LEVELS.includes(value as ColorLevel)
    ? (value as ColorLevel)
    : DEFAULT_COLOR_LEVEL;

// Accent swatches always show their family's strong fill, at every level.
export const accentButtonStyle = {
  "--affordance-prominent": "var(--affordance-accent-prominent)",
  "--affordance-prominent-hover": "var(--affordance-accent-prominent-hover)",
  "--affordance-prominent-pressed":
    "var(--affordance-accent-prominent-pressed)",
  "--text-on-prominent": "var(--text-on-accent)",
} as CSSProperties;
