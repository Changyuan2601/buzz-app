import { BUBBLE_COLORS, type BubbleColor } from "./bubble-color";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("src/shared/styles/tokens.css", "utf8");
const blocks = [...css.matchAll(/:root[^{}]*\{([^}]+)\}/g)].map((match) =>
  Object.fromEntries(
    [...(match[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2]?.trim(),
    ]),
  ),
);

// Resolve the real shared palette and host aliases in cascade order. The host
// no longer owns literal colors; a missing or cyclic alias must fail the test.
function resolvedPalette(
  mode: "light" | "dark",
  bubbleColor: BubbleColor = "neutral",
) {
  const source = (
    readFileSync("src/shared/design-system/styles/tokens.css", "utf8") +
    "\n" +
    css
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const values: Record<string, string> = {};
  for (const [, selector = "", body = ""] of source.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    if (!selector.includes(":root") && !selector.includes(".dark")) continue;
    if (
      selector.includes("data-bubble-color") &&
      !selector.includes(`data-bubble-color="${bubbleColor}"`)
    )
      continue;
    const dark =
      selector.includes('data-color-mode="dark"') || selector.includes(".dark");
    if (dark && mode !== "dark") continue;
    for (const [, name = "", value = ""] of body.matchAll(
      /(--[\w-]+):\s*([^;]+);/g,
    ))
      values[name] = value.trim();
  }
  return resolveAliases(values);
}

function resolveAliases(values: Record<string, string>) {
  const resolve = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name)) throw new Error(`Cyclic token: ${name}`);
    seen.add(name);
    const value = values[name];
    if (!value) throw new Error(`Missing token: ${name}`);
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    return alias?.[1] ? resolve(alias[1], seen) : value;
  };
  return Object.fromEntries(
    Object.keys(values).map((name) => [name, resolve(name)]),
  );
}

function luminance(hex: string | undefined) {
  if (!hex) throw new Error("Missing contrast color");
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const rgb = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb.reduce(
    (sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0),
    0,
  );
}
function contrast(a: string | undefined, b: string | undefined) {
  const x = luminance(a);
  const y = luminance(b);
  const low = Math.min(x, y);
  const high = Math.max(x, y);
  return (high + 0.05) / (low + 0.05);
}

it("both palettes define every color/elevation role, with shared radii", () => {
  expect(blocks).toHaveLength(2);
  expect(
    Object.keys(blocks[0])
      .filter((k) => !k.startsWith("--radius-"))
      .sort(),
  ).toEqual(Object.keys(blocks[1]).sort());
});

it.each([0, 1])(
  "palette %i has AA text/control token pairs (not a rendered audit)",
  (index) => {
    const t = resolvedPalette(index === 0 ? "light" : "dark");
    const textPairs: [string, string][] = [
      ["--text-standard", "--bg-app"],
      ["--text-subtle", "--bg-app"],
      ["--text-metadata", "--bg-app"],
      ...[
        "--surface",
        "--surface-accent",
        "--surface-elevated",
        "--surface-control",
        "--surface-input",
        "--surface-hover",
      ].flatMap((background) =>
        ["--text", "--text-muted"].map((foreground): [string, string] => [
          foreground,
          background,
        ]),
      ),
      ["--on-primary", "--primary"],
      ["--on-action", "--action"],
      ["--on-selected", "--selected"],
      ["--warning", "--warning-surface"],
      ["--success", "--success-surface"],
      ["--danger", "--surface"],
      ["--link", "--surface"],
    ];
    for (const [fg, bg] of textPairs)
      expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
        4.5,
      );
    for (const bg of [
      "--surface",
      "--surface-input",
      "--surface-elevated",
      "--selected",
    ]) {
      expect(
        contrast(t["--focus"], t[bg]),
        `focus on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(
      contrast(t["--border-input"], t["--surface"]),
    ).toBeGreaterThanOrEqual(3);
  },
);

it("a scoped dark surface rebinds glass roles inherited from a light app", () => {
  // Custom properties inherit computed values, not unresolved var() expressions.
  // Freeze the light root first, then cascade declarations on the .dark child.
  const values = resolvedPalette("light");
  const source = readFileSync(
    "src/shared/design-system/styles/tokens.css",
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector = "", body = ""] of source.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    if (!selector.includes(".dark")) continue;
    for (const [, name = "", value = ""] of body.matchAll(
      /(--[\w-]+):\s*([^;]+);/g,
    ))
      values[name] = value.trim();
  }
  const scoped = resolveAliases(values);
  const dark = resolvedPalette("dark");
  const light = resolvedPalette("light");
  for (const role of [
    "--bg-glass-primary",
    "--bg-glass-primary-hover",
    "--bg-glass-secondary",
    "--bg-glass-secondary-hover",
  ]) {
    expect(scoped[role], role).toBe(dark[role]);
    expect(scoped[role], role).not.toBe(light[role]);
  }
});

it.each(["light", "dark"] as const)(
  "message text and links contrast with both bubble fills in %s",
  (mode) => {
    const palette = resolvedPalette(mode);
    // Default own bubbles retain normal text and link colors.
    for (const surface of ["--surface-message", "--surface-message-own"]) {
      for (const text of surface === "--surface-message-own"
        ? ["--text-message-own", "--text-message-link-own"]
        : ["--text-standard", "--text-subtle", "--text-link"]) {
        expect(
          contrast(palette[text], palette[surface]),
          `${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Received and neutral own fills are independent authored pairs.
    expect(palette["--surface-message"]).toBe(palette["--bubble-received"]);
    expect(palette["--surface-message-own"]).toBe(palette["--bubble-neutral"]);
    expect(palette["--surface-message"]).not.toBe(
      palette["--surface-message-own"],
    );
    expect(palette["--text-message-own"]).toBe(palette["--text-standard"]);
  },
);

it.each(BUBBLE_COLORS)(
  "%s message fill keeps text and send icons readable in both modes",
  (color) => {
    for (const mode of ["light", "dark"] as const) {
      const palette = resolvedPalette(mode, color);
      expect(palette["--text-message-own"]).toBe(
        color === "neutral" ? palette["--text-standard"] : "#ffffff",
      );
      expect(palette["--text-message-link-own"]).toBe(
        color === "neutral" ? palette["--text-link"] : "#ffffff",
      );
      expect(palette["--text-message-action"]).toBe(
        color === "neutral" ? palette["--neutral-1"] : "#ffffff",
      );
      expect(
        contrast(
          palette["--text-message-link-own"],
          palette["--surface-message-own"],
        ),
        `${color} links in ${mode}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(
          palette["--text-message-action"],
          palette["--surface-message-action"],
        ),
        `${color} send icon in ${mode}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(
          palette["--text-message-own"],
          palette["--surface-message-own"],
        ),
        `${color} in ${mode}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  },
);
