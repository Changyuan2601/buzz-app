import { pluginAction } from "./plugin-settings.mjs";
import {
  chooseColorMode,
  closeSettings,
  openPage,
  openSettings,
  pageChoice,
  pageChoices,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
// A closed plugin dialog returns to Settings, the only remaining modal.
async function expectOnlySettings(page) {
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(settingsDialog(page)).toBeVisible();
}
async function openPlugins(page, origin) {
  await page.goto(origin);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
}
// Native IPC is the boundary fixture; Settings -> manager -> platform adapter are production.
async function nativeImports(page, samples = [], previewOptions = {}) {
  const input = { samples, previewOptions };
  await page.addInitScript(({ samples, previewOptions }) => {
    window.isTauri = true;
    window.importCalls = [];
    window.importDelay = false;
    const plugins = ["channels", "github", "bestie", "repos", "workflows"].map(
      (name) => ({
        manifest: { id: `buzz.${name}`, name, apiVersion: 1 },
        source: "bundled",
        enabled: true,
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
      }),
    );
    const ready = () => ({
      status: "ready",
      externalPluginsPaused: false,
      // Real IPC serializes a new snapshot; don't let later fixture writes mutate
      // the manager's previously accepted catalog and bypass reconciliation.
      catalog: {
        profile: "fixture",
        location: "isolated IPC",
        plugins: structuredClone(plugins),
      },
    });
    const preview = {
      token: "preview-one",
      source: "https://github.com/example/plugins",
      commit: "a".repeat(40),
      warnings: ["broken: Missing file: broken/plugin.js"],
      ...previewOptions,
      candidates: samples.length
        ? samples
        : ["one", "two"].map((name) => ({
            path: `plugins/${name}/dist`,
            manifest: {
              id: `example.${name}`,
              name: `Example ${name}`,
              apiVersion: 1,
            },
            revision: name,
          })),
    };
    // Match Tauri core's callback IDs and Channel serialization, not a fake
    // Channel class: constructing the production bridge must cross real JS IPC.
    let nextCallback = 0;
    const callbacks = new Map();
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback, once = false) {
        const id = ++nextCallback;
        callbacks.set(id, (value) => {
          if (once) callbacks.delete(id);
          callback?.(value);
        });
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      invoke: async (command, args) => {
        window.importCalls.push({ command, args });
        if (command === "deep_link_take") return [];
        if (command === "deep_link_watch") {
          const wireChannel = args.onEvent.toJSON();
          if (
            wireChannel !== `__CHANNEL__:${args.onEvent.id}` ||
            !callbacks.has(args.onEvent.id)
          )
            throw new Error("Invalid deep-link channel");
          return;
        }
        if (command === "plugin_catalog") return ready();
        if (
          command === "plugin_import_folder" ||
          command === "plugin_import_git"
        ) {
          if (window.importDelay)
            await new Promise((resolve) => {
              window.resolveImport = resolve;
            });
          if (args?.repository === "bad")
            throw new Error("Repository unavailable");
          if (window.importCategory)
            for (const candidate of preview.candidates)
              candidate.manifest.discovery = {
                category: window.importCategory,
              };
          return preview;
        }
        if (command === "plugin_import_discard") return;
        // Agent storage starts empty; the app saves agent state there.
        if (command === "app_agent_state_load") return {};
        if (command === "app_agent_state_set") return;
        if (command === "plugin_import_install") {
          if (window.importInstallError) {
            await new Promise((resolve) => {
              window.rejectInstall = resolve;
            });
            throw new Error(window.importInstallError);
          }
          const candidate = preview.candidates.find(
            (p) => p.path === args.path,
          );
          const existing = plugins.find(
            (p) => p.manifest.id === candidate.manifest.id,
          );
          if (existing) {
            existing.manifest = structuredClone(candidate.manifest);
            existing.previous = existing.revision;
            existing.revision = candidate.revision;
          } else
            plugins.push({
              ...candidate,
              source: "external",
              enabled: false,
              previous: null,
              reloadable: true,
              error: null,
            });
          return ready();
        }
        if (command === "plugin_reload") {
          const plugin = plugins.find((p) => p.manifest.id === args.id);
          plugin.previous = plugin.revision;
          plugin.revision = `${plugin.revision}-reload`;
          plugin.reloadable = true;
          return ready();
        }
        if (command === "plugin_change") {
          if (args.action === "remove")
            plugins.splice(
              plugins.findIndex((p) => p.manifest.id === args.id),
              1,
            );
          else
            plugins.find((p) => p.manifest.id === args.id).enabled =
              args.action === "enable";
          return ready();
        }
        if (command === "plugin_module")
          return (
            samples.find((sample) => sample.manifest.id === args.id)?.code ??
            "export function apply() {}"
          );
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, input);
}

test("browser omits native import acquisition controls", async ({
  page,
  app,
}) => {
  await openPlugins(page, app.origin);
  await expect(
    page.getByText(
      "Open the desktop app to load plugins from a folder or Git repository.",
    ),
  ).toHaveCount(0);
  await expect(button(page, "Add")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Add a plugin" })).toHaveCount(
    0,
  );
});

// Real font metrics, text wrapping and icon geometry are not observable in jsdom.
test("Settings controls scale together and keep enlarged labels reachable", async ({
  page,
  app,
}, info) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  const checkButtons = async (section, scale) => {
    await expect
      .poll(() =>
        section.evaluate((root, scale) => {
          const failures = [];
          const bounds = root.getBoundingClientRect();
          for (const label of root.querySelectorAll(
            ".buzz-choice-label, .buzz-field-label, .buzz-content-header-title",
          )) {
            // Theme choices have intentionally clipped spoken labels; measure
            // their visible thumbnails instead of the unclipped text range.
            const thumbnail = label.querySelector(".buzz-theme-thumbnail");
            if (thumbnail) {
              const box = thumbnail.getBoundingClientRect();
              if (box.left < bounds.left || box.right > bounds.right)
                failures.push("Theme preview overflows section");
              continue;
            }
            if (label.classList.contains("sr-only")) continue;
            // Measure visible text only; sr-only spans are clipped by design.
            const walker = document.createTreeWalker(
              label,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.parentElement.closest(".sr-only")) continue;
              const text = document.createRange();
              text.selectNodeContents(node);
              for (const line of text.getClientRects()) {
                if (line.left < bounds.left || line.right > bounds.right)
                  failures.push(
                    `${label.textContent}: setting label overflows section`,
                  );
              }
            }
          }
          for (const button of root.querySelectorAll("button.buzz-button")) {
            const box = button.getBoundingClientRect();
            if (button.closest(".buzz-empty-state")) {
              const label = button.querySelector(".buzz-button-label");
              const context = document.createElement("canvas").getContext("2d");
              context.font = getComputedStyle(label).font;
              if (
                (label.textContent.match(/\S+/g) ?? []).some(
                  (word) =>
                    context.measureText(word).width >
                    label.getBoundingClientRect().width,
                )
              )
                failures.push(
                  `${button.textContent}: action words break apart`,
                );
            }
            // Shared controls retain their authored 32px small or 40px default
            // minimum at 100%; enlarged labels may grow.
            const minimum = button.dataset.size === "sm" ? 32 : 40;
            if (scale === 100 && box.height !== minimum)
              failures.push(`${button.textContent}: default height changed`);
            // Compact Select deliberately ellipsizes its value; a text Range
            // includes hidden glyphs. Check the painted boxes and full-value
            // hint instead, without exempting lost clipping or escaping icons.
            const selectValue = button
              .closest('.buzz-select[data-variant="compact"]')
              ?.querySelector(".buzz-select-value");
            if (selectValue) {
              const style = getComputedStyle(selectValue);
              if (
                style.overflow !== "hidden" ||
                style.textOverflow !== "ellipsis" ||
                style.whiteSpace !== "nowrap" ||
                selectValue.getAttribute("title") !==
                  selectValue.textContent.trim()
              )
                failures.push(
                  `${button.textContent}: compact choice lost clipping or full-value hint`,
                );
            }
            const text = document.createRange();
            if (!selectValue) text.selectNodeContents(button);
            const content = selectValue
              ? [
                  ...button.querySelectorAll(
                    ".buzz-select-value, .buzz-dropdown-chevron",
                  ),
                ].map((node) => node.getBoundingClientRect())
              : [...text.getClientRects()];
            for (const line of content) {
              if (
                line.top < box.top ||
                line.bottom > box.bottom ||
                line.left < box.left ||
                line.right > box.right
              )
                failures.push(
                  `${button.textContent}: content overflows button`,
                );
            }
            const palette = button.closest("[data-accent-colors]");
            const visibleBounds = palette?.getBoundingClientRect() ?? box;
            if (
              visibleBounds.left < bounds.left ||
              visibleBounds.right > bounds.right
            )
              failures.push(
                `${button.textContent}: button [${visibleBounds.left}, ${visibleBounds.right}] overflows section [${bounds.left}, ${bounds.right}]; group inset ${getComputedStyle(button.closest(".buzz-settings-group") ?? root).getPropertyValue("--settings-group-inset")}`,
              );
          }
          return failures;
        }, scale),
      )
      .toEqual([]);
  };
  for (const scale of [100, 200]) {
    await selectSettingsSection(page, "Appearance");
    if (scale === 200) {
      for (let i = 0; i < 10; i++)
        await button(page, "Increase interface size").click();
    }
    await expect(
      page.getByRole("status", { name: "Interface size" }),
    ).toHaveText(`${scale}%`);
    for (const [width, mode] of [
      [320, "Light"],
      [800, "Dark"],
      [1280, "Light"],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await selectSettingsSection(page, "Appearance");
      const appearance = page.getByRole("region", {
        name: "Appearance",
        exact: true,
      });
      await chooseColorMode(page, mode);
      await expect(appearance.getByRole("button")).toHaveCount(
        scale === 100 ? 8 : 9,
      );
      await expect(
        appearance.getByRole("button", {
          name: "Reset interface size",
          exact: true,
        }),
      ).toHaveCount(scale === 100 ? 0 : 1);
      await page.evaluate(() => document.fonts.ready);
      await checkButtons(appearance, scale);
      const colors = appearance.locator("[data-accent-colors] button");
      await expect(colors).toHaveCount(6);
      await colors.first().focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      for (let index = 0; index < 6; index++) {
        if (index) await page.keyboard.press("Tab");
        await expect(colors.nth(index)).toBeFocused();
        await expect
          .poll(() =>
            colors.nth(index).evaluate((button) => {
              const box = button.getBoundingClientRect();
              const palette = button
                .closest("[data-accent-colors]")
                .getBoundingClientRect();
              const style = getComputedStyle(button);
              const ring =
                parseFloat(style.outlineWidth) +
                parseFloat(style.outlineOffset);
              return (
                ring === 4 &&
                box.left - ring >= palette.left &&
                box.right + ring <= palette.right &&
                box.top - ring >= palette.top &&
                box.bottom + ring <= palette.bottom
              );
            }),
          )
          .toBe(true);
      }
      await appearance.screenshot({
        path: info.outputPath(`appearance-${scale}-${width}-${mode}.png`),
      });
      // Icon buttons grow with the interface while keeping their square shape.
      // The shell toolbar stays mounted, though hidden, behind the modal.
      await expect(
        page.getByRole("button", {
          name: "Search Buzz",
          exact: true,
          includeHidden: true,
        }),
      ).toHaveAttribute("data-icon-size", "sm");
      await expect
        .poll(() =>
          settingsDialog(page)
            .locator("button[data-icon-size]")
            .evaluateAll(
              (buttons, scale) =>
                buttons
                  .filter((button) => button.getClientRects().length)
                  .map((button) => {
                    const box = button.getBoundingClientRect();
                    const sizes = {
                      sm: 32,
                      md: 40,
                      lg: 52,
                      compact: 32,
                      toolbar: 32,
                      default: 40,
                      large: 52,
                    };
                    return (
                      box.width ===
                        sizes[button.dataset.iconSize] * (scale / 100) &&
                      box.height === box.width
                    );
                  }),
              scale,
            ),
        )
        .not.toContain(false);
      await selectSettingsSection(page, "Manage plugins");
      const plugins = page.getByRole("region", {
        name: "Manage plugins",
        exact: true,
      });
      await expect(button(page, "Add")).toBeVisible();
      await checkButtons(plugins, scale);
      await button(page, "Add").click();
      const dialog = page.getByRole("dialog", { name: "Add a plugin" });
      await expect(dialog).toBeVisible();
      await checkButtons(dialog, scale);
      const folder = button(page, "Browse plugin folder");
      const repository = dialog.getByRole("textbox", {
        name: "Git or GitHub repository",
        exact: true,
      });
      if (scale === 200 && width === 320) {
        // The stacked acquisition sources retain reachable controls in the modal.
        await folder.focus();
        await page.keyboard.press("Tab");
        await expect(repository).toBeFocused();
        await expect(repository).toBeInViewport({ ratio: 1 });
        await repository.fill("example/plugins");
        await page.keyboard.press("Tab");
        await expect(
          dialog.getByRole("textbox", { name: "Branch or tag (optional)" }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(button(page, "Find plugins")).toBeFocused();
        await expect(button(page, "Find plugins")).toBeInViewport({ ratio: 1 });
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(button(page, "Add")).toBeFocused();
      await page.screenshot({
        path: info.outputPath(`settings-buttons-${scale}-${width}.png`),
      });
    }
  }
});

test("folder/Git preview selects the exact subfolder, installs disabled and warns on enabled updates", async ({
  page,
  app,
}, info) => {
  await nativeImports(
    page,
    ["one", "two"].map((name, index) => ({
      path: index === 0 ? "." : "dist",
      manifest: {
        id: `example.${name}`,
        name: `Example ${name}`,
        description:
          "Review repository activity and share detailed project updates with your community and collaborators.",
        apiVersion: 1,
      },
      revision: name,
    })),
    { source: "/plugins/example", commit: null },
  );
  await openPlugins(page, app.origin);
  await button(page, "Add").click();
  const sourceDialog = page.getByRole("dialog");
  await expect(sourceDialog).toHaveCSS("opacity", "1");
  await sourceDialog.evaluate(async (node) => {
    await Promise.all(
      node.getAnimations().map((animation) => animation.finished),
    );
  });
  await sourceDialog.screenshot({
    path: info.outputPath("plugin-source.png"),
  });
  await button(page, "Browse plugin folder").click();
  const skippedFolders = page.getByRole("region", {
    name: "Skipped folders",
  });
  await expect(skippedFolders.getByRole("list")).toHaveCSS(
    "list-style-type",
    "disc",
  );
  await expect(skippedFolders.getByRole("button")).toHaveCount(0);
  await expect(
    skippedFolders.getByText("broken: Missing file: broken/plugin.js", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Choose a plugin",
  );
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(
    "Select a plugin to review before installing.",
  );
  await expect(
    page.getByRole("radiogroup", { name: "Choose a plugin" }),
  ).toBeVisible();

  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(
    page.getByRole("radio", { name: /Example one/ }),
  ).toHaveAccessibleDescription("/plugins/example · example.one");
  await expect(
    page.getByRole("radio", { name: /Example two/ }),
  ).toHaveAccessibleDescription("/plugins/example/dist · example.two");
  await expect(button(page, "Install plugin")).toHaveCount(0);
  await expect(button(page, "Continue")).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Computer access" }),
  ).toHaveCount(0);
  await page.getByRole("radio", { name: /Example two/ }).check();
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeChecked();
  await expect(
    page.getByRole("heading", { name: "Example two", level: 3 }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await page
    .getByRole("dialog")
    .screenshot({ path: info.outputPath("plugin-choose-light.png") });
  await button(page, "Continue").click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Review plugin access",
  );
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(
    "Only install code you trust.",
  );
  await expect(
    page.getByRole("region", { name: "Skipped folders" }),
  ).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Computer access" }),
  ).toBeVisible();
  await button(page, "Back").click();
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeFocused();
  await button(page, "Continue").click();
  await page.setViewportSize({ width: 480, height: 700 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page
    .getByRole("dialog")
    .screenshot({ path: info.outputPath("plugin-review-dark.png") });
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(
    page.getByRole("heading", { name: "Example two", level: 3 }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Enable plugin" }),
  ).toBeChecked();
  await page.getByRole("switch", { name: "Enable plugin" }).uncheck();
  await button(page, "Install plugin").click();
  await expectOnlySettings(page);
  await expect(
    page.getByRole("heading", { name: "Example two", level: 3 }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_install")
          .args,
    ),
  ).toEqual({ token: "preview-one", path: "dist" });
  const enabled = pluginAction(page, "Example two");
  await expect(enabled).toHaveAccessibleName("Enable Example two");
  const row = button(page, "View Example two details");
  await expect(row).toHaveAttribute("data-updatable", "true");
  for (const width of [1100, 768]) {
    await page.setViewportSize({ width, height: 950 });
    await row.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        row.evaluate((node) => {
          const description = node.querySelector('[id^="plugin-description-"]');
          const actions = [...node.parentElement.querySelectorAll("button")]
            .filter((button) => button !== node)
            .map((button) => button.getBoundingClientRect());
          const range = document.createRange();
          range.selectNodeContents(description);
          return [...range.getClientRects()].every((rect) =>
            actions.every(
              (action) =>
                rect.right <= action.left ||
                rect.left >= action.right ||
                rect.bottom <= action.top ||
                rect.top >= action.bottom,
            ),
          );
        }),
      )
      .toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: info.outputPath("updatable-row-light.png") });
  await page.setViewportSize({ width: 480, height: 850 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: info.outputPath("updatable-row-dark-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });

  await button(page, "View Example two details").click();
  await expect(button(page, "Reload")).toBeVisible();
  await button(page, "Reload").click();
  expect(
    await page.evaluate(
      () => window.importCalls.find((c) => c.command === "plugin_reload").args,
    ),
  ).toEqual({ id: "example.two" });
  await enabled.click();
  await expect(enabled).toHaveAccessibleName("Disable Example two");
  await expect(button(page, "Reload")).toHaveCount(0);
  await button(page, "Close plugin details").click();
  await page.evaluate(() => {
    window.importCategory = "productivity";
  });
  await button(page, "Update Example two").click();
  await button(page, "Browse plugin folder").click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(
    page.getByText(/It stays on and may run immediately/),
  ).toBeVisible();
  await expect(button(page, "Update plugin")).toBeEnabled();
  await page
    .getByRole("dialog")
    .screenshot({ path: info.outputPath("plugin-update-review.png") });
  await button(page, "Update plugin").click();
  await expectOnlySettings(page);
  await expect(enabled).toHaveAccessibleName("Disable Example two");
  await expect(button(page, "Update Example two")).toBeFocused();
  await button(page, "View Example two details").click();
  await button(page, "Delete").click();
  const deletion = page.getByRole("alertdialog", {
    name: "Delete Example two?",
  });
  await expect(deletion).toBeVisible();
  await expect(
    deletion.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await deletion.screenshot({
    path: info.outputPath("plugin-delete-confirmation.png"),
  });
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(button(page, "Delete")).toBeFocused();
  await button(page, "Close plugin details").click();
  await page
    .getByRole("region", { name: "Manage plugins", exact: true })
    .screenshot({ path: info.outputPath("plugin-row-update.png") });
  await button(page, "Add").click();
  await page.getByLabel("Git or GitHub repository").fill("example/plugins");
  await page.getByLabel("Branch or tag (optional)").fill("feature/plugins");
  await button(page, "Find plugins").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_git").args,
    ),
  ).toEqual({ repository: "example/plugins", reference: "feature/plugins" });
  await button(page, "Back").click();
  await expect(button(page, "Find plugins")).toBeFocused();
  await expect(page.getByLabel("Git or GitHub repository")).toHaveValue(
    "example/plugins",
  );
  await expect(page.getByLabel("Branch or tag (optional)")).toHaveValue(
    "feature/plugins",
  );
  await page.getByLabel("Git or GitHub repository").fill("bad");
  await page.evaluate(() => {
    window.importDelay = true;
  });
  await button(page, "Find plugins").click();
  await expect(button(page, "Find plugins")).toBeDisabled();
  await page.evaluate(() => {
    window.importDelay = false;
    window.resolveImport();
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Repository unavailable" }),
  ).toBeVisible();
  await expect(button(page, "Find plugins")).toHaveCount(0);
  await button(page, "Back").click();
  await expect(button(page, "Find plugins")).toBeEnabled();
  await expect(button(page, "Find plugins")).toBeFocused();
  await expect(page.getByLabel("Git or GitHub repository")).toHaveValue("bad");
  await page.keyboard.press("Escape");
  await button(page, "View Example two details").click();
  await button(page, "Delete").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete plugin", exact: true })
    .click();
  await expect(button(page, "View Example two details")).toHaveCount(0);
});

test("resizing over the catalog keeps focus in visible plugin details", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await page.setViewportSize({ width: 1440, height: 950 });
  await openPlugins(page, app.origin);
  await button(page, "View github details").click();
  const pane = page.getByRole("complementary", { name: "github details" });
  const close = pane.getByRole("button", { name: "Close plugin details" });
  await expect(close).toBeFocused();
  await pluginAction(page, "github").focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 950 });
  await button(page, "View github details").click();
  await button(page, "Add").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await expectOnlySettings(page);
  await expect(close).toBeFocused();
});

test("leaving Settings discards a late preview without installing", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  await page.evaluate(() => {
    window.importDelay = true;
  });
  await button(page, "Add").click();
  await button(page, "Browse plugin folder").click();
  await expect(page.getByText(/Reading plugin folders/)).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Add a plugin" });
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    location.hash = `buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "page",
        pluginId: "buzz.workflows",
        pageId: "workflows",
      }),
    )}`;
  });
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.resolveImport());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.importCalls.filter(
            (c) => c.command === "plugin_import_discard",
          ).length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.importCalls.filter((c) => c.command === "plugin_import_install"),
    ),
  ).toEqual([]);
});

test("checked-in local examples activate and work independently", async ({
  page,
  app,
}) => {
  const samples = await Promise.all(
    ["counter", "notes"].map(async (name) => {
      const folder = new URL(
        `../../examples/plugins/${name}/`,
        import.meta.url,
      );
      return {
        path: name,
        manifest: JSON.parse(
          await readFile(new URL("manifest.json", folder), "utf8"),
        ),
        code: await readFile(new URL("plugin.js", folder), "utf8"),
        revision: name,
      };
    }),
  );
  await nativeImports(page, samples);
  await openPlugins(page, app.origin);
  for (const sample of samples) {
    await button(page, "Add").click();
    await button(page, "Browse plugin folder").click();
    await page
      .getByRole("radio", { name: new RegExp(sample.manifest.name) })
      .check();
    await button(page, "Continue").click();
    await button(page, "Install plugin").click();
    await expectOnlySettings(page);
    await expect(pluginAction(page, sample.manifest.name)).toHaveAccessibleName(
      `Disable ${sample.manifest.name}`,
    );
  }
  await closeSettings(page);
  await openPage(page, "Counter playground");
  await button(page, "Clicked 0 times").click();
  await expect(button(page, "Clicked 1 times")).toBeVisible();
  await openPage(page, "Notes playground");
  await page.getByLabel("Scratch note").fill("Hello plugin");
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "12 characters",
  );
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await pluginAction(page, "Counter playground").click();
  await closeSettings(page);
  const navigation = await pageChoices(page, "Counter playground");
  await expect(pageChoice(navigation, "Counter playground")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill("Notes playground");
  await expect(pageChoice(navigation, "Notes playground")).toBeVisible();
});

// Browser-only: real modal focus and manager error propagation across the IPC boundary.
test("Add keeps a rejected install reachable and retries the same preview", async ({
  page,
  app,
}, info) => {
  await nativeImports(
    page,
    [
      {
        path: "dist",
        revision: "one",
        manifest: {
          id: "example.retry",
          name: "Retry plugin",
          description:
            "Review a local plugin and its computer access before installation.",
          apiVersion: 1,
          host: {
            networkOrigins: ["https://api.example.com"],
            commands: [
              {
                id: "status",
                program: "python3",
                args: ["-c", "print('plugin status')\n".repeat(80)],
              },
            ],
          },
        },
      },
    ],
    { source: "/plugins/example", commit: null, warnings: [] },
  );
  await openPlugins(page, app.origin);
  await button(page, "Add").click();
  await button(page, "Browse plugin folder").click();
  const dialog = page
    .getByRole("dialog")
    .and(page.locator('[aria-modal="true"]'));
  await expect(dialog).toHaveAccessibleName("Review plugin access");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(
    dialog.getByText("Choose a plugin folder", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("heading", { name: "Retry plugin" }),
  ).toHaveCount(0);
  await expect(dialog.getByText("example.retry", { exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByText(/^Source:/)).toHaveCount(0);
  await expect(
    dialog.getByText(
      "Review a local plugin and its computer access before installation.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("region", { name: "Computer access" }),
  ).toBeVisible();
  await expect(dialog.getByText(/^Folder:/)).toHaveCount(0);
  await expect(
    dialog.getByRole("region", { name: "Plugin import preview" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "Add from folder" }),
  ).toBeHidden();
  await expect(dialog.getByRole("form", { name: "Add from Git" })).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Back", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Install plugin", exact: true }),
  ).toHaveAttribute("data-variant", "prominent");
  await expect(
    dialog.getByRole("region", { name: "Skipped folders" }),
  ).toHaveCount(0);
  const access = dialog.getByRole("region", { name: "Computer access" });
  await expect(access.getByText("Run python3")).toBeVisible();
  const summaryList = access.getByRole("region", { name: "Declared scopes" });
  const computer = access.getByRole("button", { name: /^Computer access/ });
  await expect(access.getByRole("button").first()).toHaveText(
    /Computer access/,
  );
  await expect(computer).toHaveAttribute("aria-expanded", "false");
  await computer.click();
  await expect(
    access.getByRole("region", { name: "Plugin safety" }),
  ).toBeVisible();
  await expect(
    access.getByRole("region", { name: "Plugin safety" }),
  ).toContainText("Plugins aren’t sandboxed");
  await dialog.screenshot({
    path: info.outputPath("computer-access-expanded.png"),
  });
  await computer.click();
  await expect(
    access.getByRole("region", { name: "Plugin safety" }),
  ).toHaveCount(0);
  await expect(access.getByText(/Inspect exact commands/)).toHaveCount(0);
  await expect(summaryList.getByRole("button")).toHaveCount(2);
  await expect(summaryList).toContainText("Connect to https://api.example.com");
  await expect(access.getByText(/^Command status:/)).toHaveCount(0);
  const details = access.getByRole("button", {
    name: /^Run python3/,
  });
  await details.focus();
  await details.press("Enter");
  await expect(access.getByText(/^Command status:/)).toBeVisible();
  const script = access.getByLabel("Argument 2").locator("code");
  expect(await script.textContent()).toBe(
    "print('plugin status')\n".repeat(80),
  );
  await expect(script.locator("..")).toHaveCSS("white-space", "pre-wrap");
  await expect(script).toHaveCSS("word-break", "normal");
  await expect(access.locator("code").first()).toHaveCSS(
    "font-family",
    /monospace/,
  );
  const codeRegion = access.getByRole("region", {
    name: "Command status details",
  });
  await expect(
    access.getByRole("button", { name: /^Connect to/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    access.getByRole("region", { name: /^HTTPS origin / }),
  ).toHaveCount(0);
  for (const [width, mode] of [
    [900, "light"],
    [480, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect
      .poll(() =>
        codeRegion.evaluate((node) => ({
          bounded:
            node.clientHeight <= parseFloat(getComputedStyle(node).maxHeight),
          scrolls: node.scrollHeight > node.clientHeight,
          distinctBackground:
            getComputedStyle(node).backgroundColor !==
            getComputedStyle(node.closest('[role="dialog"]')).backgroundColor,
        })),
      )
      .toEqual({ bounded: true, scrolls: true, distinctBackground: true });
    await codeRegion.focus();
    // Cross a meaningful scroll boundary before reversing direction. End/Home
    // can align text lines instead of the padded scrollport edges across engines.
    const midpoint = await codeRegion.evaluate(
      (node) =>
        Math.min(node.clientHeight, node.scrollHeight - node.clientHeight) / 2,
    );
    for (const [key, direction] of [
      ["PageDown", "down"],
      ["PageUp", "up"],
    ]) {
      // Register before the key and finish native scrolling before reversing it.
      const completion = await codeRegion.evaluateHandle(
        (node, { midpoint, direction }) => ({
          done: new Promise((resolve) => {
            const settled = () => {
              const reached =
                direction === "down"
                  ? node.scrollTop > midpoint
                  : node.scrollTop < midpoint;
              // Focus/layout may finish an earlier scroll before this key does.
              if (!reached) return;
              node.removeEventListener("scrollend", settled);
              resolve();
            };
            node.addEventListener("scrollend", settled);
          }),
        }),
        { midpoint, direction },
      );
      await codeRegion.press(key);
      await completion.evaluate(({ done }) => done);
      await completion.dispose();
      const position = await codeRegion.evaluate((node) => node.scrollTop);
      if (direction === "down") expect(position).toBeGreaterThan(midpoint);
      else expect(position).toBeLessThan(midpoint);
    }
    // Position the capture independently of keyboard-scroll alignment.
    await codeRegion.evaluate((node) => {
      node.scrollTop = 0;
    });
    await details
      .locator("xpath=ancestor::*[contains(@class, 'buzz-accordion-item')][1]")
      .screenshot({
        path: info.outputPath(`plugin-scope-details-${mode}.png`),
      });
  }
  await details.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  // Pointer expansion uses the shared height transition and Motion content fade.
  await details.click();
  const panel = summaryList.locator(".buzz-accordion-panel").first();
  await expect(panel).toHaveCSS("transition-property", "height");
  await expect(panel.locator(":scope > div")).toHaveCSS("opacity", "1");
  await expect(codeRegion).toBeVisible();
  await details.click();
  await expect(codeRegion).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await details.click();
  await expect(panel).toHaveCSS("transition-property", "none");
  await expect(panel.locator(":scope > div")).toHaveCSS("opacity", "1");
  await details.click();
  await expect(codeRegion).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const [width, mode] of [
    [900, "light"],
    [480, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await dialog.screenshot({
      path: info.outputPath(`plugin-preview-${mode}.png`),
    });
  }
  await page.evaluate(() => {
    window.importInstallError =
      "Publisher mismatch. Choose a package from the installed publisher.";
  });
  await dialog
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Install plugin", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.rejectInstall());
  await expect(dialog.getByRole("alert")).toContainText("Publisher mismatch");
  await expect(
    dialog.getByRole("region", { name: "Plugin import preview" }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("region", { name: "Add from folder" }),
  ).toBeHidden();
  const back = dialog.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeFocused();
  for (const [width, mode] of [
    [900, "light"],
    [480, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(back).toBeInViewport({ ratio: 1 });
    await dialog.screenshot({
      path: info.outputPath(`plugin-install-error-${mode}.png`),
    });
  }
  await back.press("Enter");
  await expect(
    dialog.getByRole("region", { name: "Plugin import preview" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Install plugin", exact: true }),
  ).toBeFocused();
  await page.evaluate(() => {
    window.importInstallError = null;
  });
  await dialog
    .getByRole("button", { name: "Install plugin", exact: true })
    .press("Enter");
  await expectOnlySettings(page);
  await expect(pluginAction(page, "Retry plugin")).toHaveAccessibleName(
    "Disable Retry plugin",
  );
  expect(
    await page.evaluate(() =>
      window.importCalls
        .filter((c) => c.command === "plugin_import_install")
        .map((c) => c.args),
    ),
  ).toEqual(Array(2).fill({ token: "preview-one", path: "dist" }));
});
