/** Existing accent identities, reused by plugin artwork. */
export const BRAND_SHADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export const BRAND_FAMILIES = [
  { id: "cobalt", hue: 266.6948 },
  { id: "iris", hue: 284.502 },
  { id: "magenta", hue: 355.6028 },
  { id: "flame", hue: 34.6181 },
  { id: "jade", hue: 169.9836 },
  { id: "chartreuse", hue: 109.5919 },
] as const;
/** Cross-color pairs preserve the plugin artwork direction; accent ramps above
 * remain the existing Appearance choices, not replacements for these endpoints. */
export const BRAND_GRADIENTS = [
  {
    name: "Communication",
    category: "communication",
    from: "cyan",
    to: "blue",
    fromHue: 220,
    toHue: 255,
  },
  {
    name: "Agents",
    category: "agents",
    from: "violet",
    to: "indigo",
    fromHue: 295,
    toHue: 260,
  },
  {
    name: "Agent tools",
    category: "agent-tools",
    from: "fuchsia",
    to: "purple",
    fromHue: 335,
    toHue: 300,
  },
  {
    name: "Developer tools & integrations",
    category: "developer-tools-and-integrations",
    from: "coral",
    to: "pink",
    fromHue: 375,
    toHue: 340,
  },
  {
    name: "People & communities",
    category: "people-and-communities",
    from: "scarlet",
    to: "orange",
    fromHue: 380,
    toHue: 415,
  },
  {
    name: "Productivity",
    category: "productivity",
    from: "gold",
    to: "lime",
    fromHue: 420,
    toHue: 455,
  },
] as const;
