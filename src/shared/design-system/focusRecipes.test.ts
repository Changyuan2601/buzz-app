import { readdirSync, readFileSync } from "node:fs";

import { expect, it } from "vitest";

const SRC = new URL("../../", import.meta.url);

/** Every stylesheet under src/, as text (see tokens/registry.test.ts on `?raw`). */
const sheets = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".css"))
  .map((path) => ({
    path,
    text: readFileSync(new URL(path, SRC), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    ),
  }));

/**
 * Blink keys style invalidation by attribute name and the rightmost compound's
 * class, tag or attribute. A focus recipe under html[data-keyboard-navigation]
 * therefore restyles every element its subject names (every button, link, or
 * code block) whenever the modality changes. The modality owner marks the
 * focused control instead, so recipes match `:focus-visible[data-keyboard-focus]`.
 */
it("gates focus recipes on the focused control's modality mark", () => {
  expect(sheets.length).toBeGreaterThan(20);
  const gated = sheets.flatMap(({ path, text }) =>
    [
      ...text.matchAll(
        /html\[data-keyboard-navigation\][^{},]*:focus-visible[^{]*\{/g,
      ),
    ].map(([selector]) => `${path}: ${selector.replace(/\s+/g, " ")}`),
  );
  expect(gated).toEqual([]);
  expect(
    sheets.some(({ text }) =>
      text.includes(":focus-visible[data-keyboard-focus]"),
    ),
  ).toBe(true);
});
