import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Browser-only boundaries: measured overflow/simulated native insets, keyboard focus on
// resize, and real App wiring between Messages and Me. Contract matrices stay in RTL.
test.use({ pluginFixtures: true });

test("Me replaces the sidebar while Messages preserves its draft and history", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  const topbar = page.getByRole("navigation", { name: "Topbar pages" });
  await expect(topbar.getByRole("button")).toHaveText(["Me", "Messages"]);
  await topbar.getByRole("button", { name: "Me", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Me sidebar" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  await expect(
    topbar.getByRole("button", { name: "Me", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Hide Me sidebar" }).click();
  await expect(page.locator("#shell-navigation")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.getByRole("button", { name: "Show Me sidebar" }).click();
  await topbar.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(composer).toHaveText("Keep this draft");
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).toBeVisible();
  await openPage(page, "Settings");
  await expect(topbar.locator('[aria-current="page"]')).toHaveCount(0);
});

test("header pages remain reachable without overlap through scale and resize", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "system");
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 2,
        enabled: { "fixture.page-placement": true },
      }),
    );
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const topbar = page.getByRole("navigation", { name: "Topbar pages" });
  const toolbar = page.getByRole("navigation", { name: "Toolbar pages" });
  const more = page.getByRole("button", { name: "More pages", exact: true });
  const me = topbar.getByRole("button", { name: "Me", exact: true });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect(topbar).toBeVisible();
    const geometry = await page.locator(".shell-header").evaluate((header) => {
      const rect = (selector) =>
        header.querySelector(selector).getBoundingClientRect();
      return {
        left: rect(".shell-communities").right,
        center: rect(".shell-topbar-pages").toJSON(),
        right: rect(".shell-actions").left,
        width: header.clientWidth,
      };
    });
    expect(geometry.center.x).toBeGreaterThan(geometry.left);
    expect(geometry.center.right).toBeLessThan(geometry.right);
    expect(
      Math.abs(
        geometry.center.x + geometry.center.width / 2 - geometry.width / 2,
      ),
    ).toBeLessThan(1);
    await toolbar.getByRole("button", { name: "Toolbar destination" }).click();
    await expect(
      page.getByRole("heading", { name: "Toolbar destination" }),
    ).toBeVisible();
    await expect(toolbar.getByRole("button")).toHaveAttribute(
      "aria-current",
      "page",
    );
    // 800px exercises measured overflow, not only the <=650px CSS fallback.
    for (const width of [800, 650, 390]) {
      await me.focus();
      await page.setViewportSize({ width, height: 950 });
      await expect(more).toBeFocused();
      await expect(topbar).not.toBeVisible();
      await expect(toolbar).not.toBeVisible();
      await more.press("Enter");
      const choices = page.getByRole("navigation", { name: "Header pages" });
      await expect(choices.getByRole("button")).toHaveText([
        "Me",
        "Messages",
        "A deliberately long topbar destination",
        "Toolbar destination",
      ]);
      await page.keyboard.press("Escape");
      await expect(choices).toHaveCount(0);
      await expect(more).toBeFocused();
      await more.press("Enter");
      await choices.getByRole("button", { name: "Me", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Me", exact: true }),
      ).toBeVisible();
      await expect(more).not.toHaveAttribute("aria-expanded", "true");
      // Widen with focus inside the open overflow, not only on its trigger.
      await more.click();
      await choices
        .getByRole("button", { name: "Messages", exact: true })
        .focus();
      await page.setViewportSize({ width: 1600, height: 950 });
      await expect(choices).toHaveCount(0);
      await expect(me).toBeFocused();
    }
  }
  // Simulate the native reserve and 200% interface text size, not native drag behavior.
  await page
    .locator(".shell-header")
    .evaluate((header) => header.classList.add("shell-header-mac"));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(more).toBeVisible();
  await more.click();
  await expect(
    page
      .getByRole("navigation", { name: "Header pages" })
      .getByRole("button", { name: "Messages", exact: true }),
  ).toBeVisible();
});
