import { setPluginEnabled } from "./plugin-settings.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  closeSettings,
  openSettings,
  settingsDialog,
  settingsSections,
} from "./navigation.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

test("a collapsible sidebar yields to narrow drawer styles during resize", async ({
  page,
  app,
}) => {
  await open(page, app);
  const navigation = page.locator("#shell-navigation");
  await expect(navigation).toHaveAttribute("data-sidebar-collapsible", "true");

  await page.setViewportSize({ width: 390, height: 900 });
  // Model the desktop marker remaining for a frame until React observes the
  // media-query change; narrow drawer CSS must still win during that interval.
  await navigation.evaluate((element) => {
    element.setAttribute("data-sidebar-collapsible", "true");
  });
  await expect(navigation).toHaveCSS("display", "none");

  await button(page, "Show navigation").click();
  await expect(navigation).toHaveAttribute("data-expanded", "true");
  await expect(navigation).toHaveCSS("display", "flex");
  await expect(navigation).toBeVisible();
});

// A retired section remains an addressed content destination in Forward history.
test("a retired contributed Settings destination fails promptly on Forward", async ({
  page,
  app,
}) => {
  await open(page, app);
  await button(page, "Beta").click();
  await expect(composer(page, "Beta")).toBeVisible();
  await openSettings(page);
  const sections = settingsSections(page);
  const managePlugins = sections.getByRole("button", {
    name: "Manage plugins",
    exact: true,
  });
  await managePlugins.click();
  await setPluginEnabled(page, "Pair mobile", true);
  const pairing = sections.getByRole("button", {
    name: "Pair mobile",
    exact: true,
  });
  await expect(pairing).toBeVisible();
  await pairing.click();
  await expect(pairing).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(managePlugins).toHaveAttribute("aria-current", "page");
  await setPluginEnabled(page, "Pair mobile", false);
  await expect(pairing).toHaveCount(0);
  await page.goForward();
  await expect(
    page.getByRole("alert").getByRole("heading", {
      name: "This destination couldn’t open",
      exact: true,
    }),
  ).toBeVisible({ timeout: 3000 });
});

test("channel visits, toolbar, browser traversal and Settings sections share one history", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  expect(alpha.target.channelId).toBe("alpha");
  await button(page, "Beta").click();
  await expect(composer(page, "Beta")).toBeVisible();
  const beta = await entry(page);
  expect(beta.id).not.toBe(alpha.id);
  await button(page, "Go back").click();
  await expect(composer(page, "Alpha")).toBeVisible();
  expect((await entry(page)).id).toBe(alpha.id);
  // Reclick is retry, not a new visit or forward-stack truncation.
  await button(page, "Alpha").click();
  expect((await entry(page)).id).toBe(alpha.id);
  await expect(button(page, "Go forward")).toBeEnabled();
  await button(page, "Go forward").click();
  await expect(composer(page, "Beta")).toBeVisible();
  expect((await entry(page)).id).toBe(beta.id);
  await page.goBack();
  await expect(composer(page, "Alpha")).toBeVisible();
  await page.goForward();
  await expect(composer(page, "Beta")).toBeVisible();
  await openSettings(page);
  const sections = settingsSections(page);
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sections
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // Option/Alt arrows are native editing controls, not Buzz history shortcuts.
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const appearance = await entry(page);
  // Back returns to the preceding section, then leaves at the first section.
  await page.goBack();
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(composer(page, "Alpha")).toBeVisible();
  await page.goForward();
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await closeSettings(page);
  await expect(composer(page, "Beta")).toBeVisible();
  expect((await entry(page)).id).toBe(appearance.id);
});
