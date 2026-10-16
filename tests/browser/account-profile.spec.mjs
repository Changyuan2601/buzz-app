import { test, expect } from "./fixture.mjs";
import { selectSettingsSection } from "./navigation.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

// Real menu dismissal must hand focus to Settings even without a relay session.
test("account avatar opens profile Settings after a failed connection", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/session", (route) => {
    app.report.startupFailures ??= [];
    app.report.startupFailures.push(route.request().url());
    return route.fulfill({
      status: 502,
      json: { error: "Connection unavailable" },
    });
  });
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "Open Settings", exact: true })
    .click();
  await selectSettingsSection(page, "Appearance");
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("Enter");
  const menu = page.locator("[data-profile-menu]");
  const edit = menu.getByRole("menuitem", { name: /, edit profile$/ });
  await expect(edit).toBeFocused();
  await edit.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeFocused();
});

// Portaled submenus need real hit testing, collision handling and keyboard focus.
test("account menu choices remain reachable across themes, widths and enlarged text", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  const menu = page.locator("[data-profile-menu]");
  const appearance = menu.getByRole("menuitem", {
    name: "Appearance",
    exact: true,
  });
  const choices = page.getByRole("menu", { name: "Appearance", exact: true });
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => localStorage.setItem("buzz-appearance.v1", mode),
      mode,
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1280, 800, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await trigger.click();
      await expect(menu).toBeInViewport({ ratio: 1 });
      await appearance.hover();
      await expect(choices).toBeInViewport({ ratio: 1 });
      await expect(
        choices.getByRole("menuitemradio", {
          name: mode === "light" ? "Light" : "Dark",
          exact: true,
        }),
      ).toBeChecked();
      await choices.evaluate(async (element) => {
        await Promise.allSettled(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      await page.screenshot({
        path: testInfo.outputPath(`appearance-${mode}-${width}.png`),
      });
      await choices
        .getByRole("menuitemradio", { name: "System", exact: true })
        .click();
      await expect(
        choices.getByRole("menuitemradio", { name: "System", exact: true }),
      ).toBeChecked();
      await choices
        .getByRole("menuitemradio", {
          name: mode === "light" ? "Light" : "Dark",
          exact: true,
        })
        .click();
      await page.keyboard.press("Escape");
      await expect(choices).toHaveCount(0);
      await expect(appearance).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.reload();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(menu).toBeInViewport({ ratio: 1 });
  await appearance.focus();
  await appearance.press("ArrowRight");
  await expect(choices).toBeInViewport({ ratio: 1 });
  await choices
    .getByRole("menuitemradio", { name: "Light", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    choices.getByRole("menuitemradio", { name: "Dark", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.screenshot({
    path: testInfo.outputPath("appearance-enlarged.png"),
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Plugins", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("main")).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await trigger.click();
  await menu.getByRole("menuitem", { name: /, edit profile$/ }).click();
  await expect(
    page.getByRole("region", { name: "Profile", exact: true }),
  ).toBeVisible();
});
