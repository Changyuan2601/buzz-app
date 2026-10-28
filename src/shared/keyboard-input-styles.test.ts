import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Splits at `separator` outside parentheses and brackets. */
function split(text: string, separator: RegExp) {
  const parts = [""];
  let depth = 0;
  for (const character of text) {
    if ("([".includes(character)) depth++;
    if (")]".includes(character)) depth--;
    if (!depth && separator.test(character)) parts.push("");
    else parts[parts.length - 1] += character;
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Keyboard input starts on most first keypresses after a pointer action and
// stops on the next pointer action. Blink restyles the whole document for a
// root attribute rule whose subject names no class, id, attribute or tag.
it("keyboard input rules name their subject, so a modality change restyles only it", () => {
  const unnamed = cssFiles("src").flatMap((file) =>
    [
      ...readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{};]+)\{/g),
    ].flatMap(([, prelude = ""]) =>
      split(prelude, /,/)
        .filter((selector) => selector.includes("data-keyboard-input"))
        .filter((selector) => {
          const subject = split(selector, /[\s>+~]/).at(-1) ?? "";
          return !/^[a-z]|[.#[]/i.test(subject);
        })
        .map((selector) => `${file}: ${selector}`),
    ),
  );
  expect(unnamed).toEqual([]);
});
