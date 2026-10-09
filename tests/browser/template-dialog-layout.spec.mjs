import { test, expect } from "./fixture.mjs";
import {
  chooseColorMode,
  openPage,
  selectSettingsSection,
  settleShellToggle,
} from "./navigation.mjs";

test.use({
  // Keep the real startup barrier: this layout journey does not hold startup
  // requests and must not open the account menu before initial composer focus.
  launchAnimation: true,
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 0, beta: 0 },
});

// Browser contract: modal headers, disclosed controls, and wrapping actions stay
// reachable across themes/widths. Save, failure, and disclosure state use RTL.
test("template dialogs keep headers and optional setup contained across layouts", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  await page
    .getByRole("switch", { name: "Enable Templates & teams", exact: true })
    .check();
  for (const mode of ["light", "dark"]) {
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await settleShellToggle(page);
      const showNavigation = page.getByRole("button", {
        name: "Show navigation",
        exact: true,
      });
      if (await showNavigation.isVisible()) await showNavigation.click();
      await page
        .getByRole("complementary", { name: "Settings sidebar" })
        .getByRole("button", { name: "Templates", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Templates settings" }),
      ).toBeVisible();
      const library = page.getByRole("region", {
        name: "Templates settings",
      });
      await expect(
        library.getByText("Your next channel starts here", { exact: true }),
      ).toBeVisible();
      await expect(
        library.getByText("Bring your agents together", { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await contained(library);
      if (width === 1440)
        await library.screenshot({
          path: info.outputPath(`library-${mode}.png`),
        });
      await library
        .getByRole("button", { name: "New template", exact: true })
        .click();
      const editor = page.getByRole("dialog", {
        name: "New template",
        exact: true,
      });
      const name = editor.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toBeFocused();
      await expect(
        editor.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
      ).toHaveCount(0);
      await contained(editor);
      await expect(editor).toHaveAccessibleDescription(
        /existing channels stay unchanged/,
      );
      await expect(editor).toHaveCSS("backdrop-filter", "blur(8px)");
      await expect(editor).toHaveCSS(
        "background-color",
        mode === "light" ? "rgba(255, 255, 255, 0.9)" : "rgba(40, 40, 40, 0.9)",
      );
      if (width === 1440)
        await editor.screenshot({
          path: info.outputPath(`new-template-${mode}.png`),
        });
      await editor
        .getByRole("button", { name: "Teams & agents", exact: true })
        .click();
      await editor
        .getByRole("button", { name: "Starting Canvas", exact: true })
        .click();
      const canvas = editor.getByRole("textbox", {
        name: "Starting Canvas (Markdown)",
      });
      await canvas.fill("# A draft that survives disclosure");
      await editor
        .getByRole("button", { name: "Starting Canvas · Added" })
        .press("Enter");
      await expect(canvas).not.toBeVisible();
      await editor
        .getByRole("button", { name: "Starting Canvas · Added" })
        .press("Enter");
      await expect(canvas).toHaveValue("# A draft that survives disclosure");
      await contained(editor);
      if (width === 390)
        await editor.screenshot({
          path: info.outputPath(`expanded-template-${mode}-narrow.png`),
        });
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        library.getByRole("button", { name: "New template", exact: true }),
      ).toBeFocused();
      await openPage(page, "Agents");
      const teams = page.getByRole("region", { name: "Agents", exact: true });
      await expect(
        teams.getByText("Bring your agents together", { exact: true }),
      ).toBeVisible();
      await teams
        .getByRole("button", { name: "Create team", exact: true })
        .click();
      const team = page.getByRole("dialog", { name: "Add team", exact: true });
      await expect(team).toHaveAccessibleDescription(/Choose agents/);
      await expect(
        team.getByRole("textbox", { name: "Name", exact: true }),
      ).toBeFocused();
      await contained(team);
      await team
        .getByRole("button", { name: "Close templates", exact: true })
        .click();
      await expect(team).toHaveCount(0);
      await expect(
        teams.getByRole("button", { name: "Create team", exact: true }),
      ).toBeFocused();
      await page
        .getByRole("button", { name: "Your profile", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
    }
  }
});

async function contained(dialog) {
  await dialog.evaluate(async (node) => {
    await document.fonts.ready;
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await expect
    .poll(() =>
      dialog.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const failures = [];
        if (
          box.left < 0 ||
          box.right > innerWidth ||
          box.top < 0 ||
          box.bottom > innerHeight
        )
          failures.push("dialog outside viewport");
        for (const control of node.querySelectorAll(
          "button, input, textarea",
        )) {
          if (!control.checkVisibility()) continue;
          const bounds = control.getBoundingClientRect();
          if (bounds.left < box.left || bounds.right > box.right)
            failures.push(
              control.textContent || control.getAttribute("aria-label"),
            );
        }
        return failures;
      }),
    )
    .toEqual([]);
}
