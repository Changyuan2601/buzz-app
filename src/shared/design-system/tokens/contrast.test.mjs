import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tokens = readFileSync(
  join(root, "src/shared/design-system/styles/tokens.css"),
  "utf8",
);

// Exercise the real CLI against isolated stylesheet mutations. No repository
// files are changed, and a green status proves the guard actually ran.
function check(css) {
  const fixture = mkdtempSync(join(tmpdir(), "buzz-contrast-"));
  try {
    mkdirSync(join(fixture, "scripts/design-system"), { recursive: true });
    mkdirSync(join(fixture, "src/shared/design-system/styles"), {
      recursive: true,
    });
    for (const name of ["check-contrast.mjs", "apca.mjs"])
      copyFileSync(
        join(root, "scripts/design-system", name),
        join(fixture, "scripts/design-system", name),
      );
    writeFileSync(
      join(fixture, "src/shared/design-system/styles/tokens.css"),
      css,
    );
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts/design-system/check-contrast.mjs")],
      { encoding: "utf8" },
    );
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("semantic contrast contract", () => {
  it("checks the current text and state-boundary pairs in both modes", () => {
    const result = check(tokens);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "checked text and control/state boundaries",
    );
    expect(result.output).not.toContain("accepted link contrast");
    expect(result.output.match(/\(accepted Away contrast\)/g)).toHaveLength(9);
    expect(result.output).toContain("not a contrast pass");
    expect(result.output).not.toContain("exceptions no longer needed");
  });

  it.each([
    [
      "light foreground",
      "--blue-11: #0b5fa8;",
      "--blue-11: #0d74ce;",
      "on --affordance-selected",
    ],
    [
      "dark foreground",
      "--blue-11: #83c4ff;",
      "--blue-11: #70b8ff;",
      "on --surface-panel",
    ],
    [
      "light surface",
      "--neutral-3: #e8e8e8;",
      "--neutral-3: #999999;",
      "on --affordance-selected",
    ],
    [
      "dark surface",
      "--neutral-raised: #282828;",
      "--neutral-raised: #595959;",
      "on --surface-popover",
    ],
    [
      "another surface role",
      "--surface-inset: var(--neutral-2);",
      "--surface-inset: var(--neutral-7);",
      "on --surface-inset",
    ],
    [
      "hover role",
      "--affordance-link-hover: var(--blue-3);",
      "--affordance-link-hover: var(--blue-8);",
      "on --affordance-link-hover",
    ],
    [
      "hover color",
      "--blue-3: #0d2847;",
      "--blue-3: #595959;",
      "on --affordance-link-hover",
    ],
  ])(
    "rejects unreadable link text after a change to %s",
    (_name, from, to, pairing) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toMatch(
        new RegExp(`--text-link \\([^\\n]+\\) ${pairing}`),
      );
    },
  );

  it.each([
    [
      "wrong dark ink",
      "--accent-contrast-dark: #ffffff;",
      "--accent-contrast-dark: #000000;",
      "magenta/neutral/dark",
    ],
    [
      "unresolved ink",
      "--accent-contrast-light: #ffffff;",
      "--accent-contrast-light: var(--missing-ink);",
      "magenta/neutral/light: unresolved accent pair",
    ],
    [
      "faint insertion line",
      "--accent-11-light: #6c3149;",
      "--accent-11-light: #feedf3;",
      "magenta/neutral/light: --border-accent",
    ],
  ])(
    "rejects a non-default accent family's %s",
    (_name, from, to, evidence) => {
      const start = tokens.indexOf('[data-accent="magenta"] {');
      expect(start).toBeGreaterThan(0);
      const end = tokens.indexOf("}", start);
      const family = tokens.slice(start, end);
      expect(family).toContain(from);
      const result = check(
        tokens.slice(0, start) + family.replace(from, to) + tokens.slice(end),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(evidence);
    },
  );

  it("checks shared color groups at every applicable level", () => {
    const from = "--text-row-subtle: var(--accent-11);";
    expect(tokens).toContain(from);
    const result = check(
      tokens.replaceAll(from, "--text-row-subtle: var(--accent-6);"),
    );
    expect(result.status, result.output).toBe(1);
    for (const level of ["touch", "high"])
      expect(result.output).toContain(
        `citrus/${level}/light --text-row-subtle`,
      );
  });

  it("rejects a gray role left on an accent ground", () => {
    const from = "--text-row-subtle: var(--accent-11);";
    expect(tokens).toContain(from);
    const result = check(
      tokens.replaceAll(from, "--text-row-subtle: var(--neutral-10);"),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      "citrus/touch/light: --text-row-subtle #525252 is gray on --affordance-selected",
    );
  });

  it.each([
    ["#000000", false],
    ["#262626", false],
    ["#404040", true],
  ])(
    "distinguishes black ink %s from gray on the brand-filled selection",
    (ink, gray) => {
      const from =
        "--text-row-selected-subtle: var(--text-navigation-selected);";
      expect(tokens).toContain(from);
      const result = check(
        tokens.replaceAll(from, `--text-row-selected-subtle: ${ink};`),
      );
      if (gray) {
        expect(result.status, result.output).toBe(1);
        expect(result.output).toContain(
          `citrus/high/light: --text-row-selected-subtle ${ink} is gray on --affordance-navigation-selected`,
        );
      } else {
        // A literal ink applies to every family, so saturated accents may fail
        // contrast; only the gray verdict is under test here.
        expect(result.output).not.toContain(
          "is gray on --affordance-navigation-selected",
        );
      }
    },
  );

  it("rejects a shell color that hides navigation text", () => {
    const result = check(
      tokens.replace(
        "--bg-app: var(--neutral-quiet-hover);",
        "--bg-app: var(--neutral-7);",
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/light\s+--text-subtle .* on --bg-app/);
  });

  it("checks other text roles without a link exception", () => {
    const result = check(
      tokens.replaceAll(
        "--text-accent: var(--accent-11);",
        "--text-accent: var(--blue-9);",
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(
      /dark\s+--text-accent .* on --surface-popover/,
    );
  });

  it.each([
    [
      "metadata",
      "--neutral-9: #5f5f5f;",
      "--neutral-9: #666666;",
      "--text-metadata",
    ],
    [
      "accent hover",
      "--accent-10-light: #2176d9;",
      "--accent-10-light: #9a5cd0;",
      "--text-on-accent",
    ],
  ])(
    "rejects the former %s pair that clears APCA but fails WCAG AA",
    (_name, from, to, role) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replace(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(role);
      expect(result.output).toContain("needs 4.5:1");
    },
  );

  it.each(["danger", "warning"])(
    "rejects the former low-contrast %s boundary",
    (role) => {
      const hue = role === "danger" ? "red" : "amber";
      const result = check(
        tokens.replaceAll(
          new RegExp(`--border-${role}: var\\(--${hue}-\\d+\\);`, "g"),
          `--border-${role}: var(--${hue}-8);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --border-${role} on --surface-panel`,
      );
      expect(result.output).toContain(
        `dark: --border-${role} on --surface-popover`,
      );
    },
  );

  it.each([
    ["online", "green"],
    ["avatar-online-border", "green"],
    ["away", "amber"],
    ["offline", "neutral"],
  ])("checks %s status on supported surfaces in both modes", (role, hue) => {
    const result = check(
      tokens.replaceAll(
        new RegExp(`--status-${role}: var\\(--${hue}-\\d+\\);`, "g"),
        `--status-${role}: var(--${hue}-5);`,
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      `light: --status-${role} on --surface-panel`,
    );
    expect(result.output).toContain(
      `dark: --status-${role} on --surface-popover`,
    );
  });

  it.each([["online", "green"]])(
    "rejects a %s outline that disappears on hover or selection",
    (role, hue) => {
      const result = check(
        tokens.replaceAll(
          `--status-avatar-${role}-border: var(--${hue}-11);`,
          `--status-avatar-${role}-border: var(--${hue}-10);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --status-avatar-${role}-border on --affordance-selected`,
      );
    },
  );

  it.each([
    [
      "fill",
      "--amber-10: #ffba18;",
      "--amber-10: #ffba19;",
      "light: --status-away on --surface-panel",
    ],
    [
      "surface",
      "--neutral-4: #dadada;",
      "--neutral-4: #dbdbdb;",
      "light: --status-away on --neutral-4",
    ],
    [
      "dark mode",
      "--amber-10: #ffd60a;",
      "--amber-10: #333333;",
      "dark: --status-away on --surface-popover",
    ],
    [
      "other role",
      "--status-offline: var(--neutral-8);",
      "--status-offline: var(--amber-10);",
      "light: --status-offline on --surface-panel",
    ],
  ])(
    "does not extend the Away exception to a changed %s",
    (_name, from, to, pairing) => {
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(pairing);
    },
  );

  it.each(["warning", "success", "accent"])(
    "checks %s text against its semantic fill, not only the palette",
    (role) => {
      const [from, to] =
        role === "accent"
          ? [
              "--affordance-accent: var(--accent-3);",
              "--affordance-accent: var(--accent-9);",
            ]
          : [
              `--affordance-${role}: var(--${role === "warning" ? "amber" : "green"}-3);`,
              `--affordance-${role}: var(--${role === "warning" ? "amber" : "green"}-9);`,
            ];
      expect(tokens).toContain(from);
      const result = check(tokens.replaceAll(from, to));
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`--text-${role}`);
      expect(result.output).toContain(`on --affordance-${role}`);
    },
  );
});
