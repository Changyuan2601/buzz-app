import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ pluginFixtures: true });

// Native history traversal and reload over the real address cannot be
// represented in jsdom. Section switches and the retained-workspace contract
// live in the App and navigation service tests.
test("Settings is reloadable but never a Back/Forward destination, and Close restores the page", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const beta = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  const dialog = settingsDialog(page);
  const entry = () => page.evaluate(() => history.state.buzzNavigationV1.entry);
  const canGoForward = () =>
    page.evaluate(() => window.fixtureNavigation.snapshot().canGoForward);
  const length = () => page.evaluate(() => history.length);
  // Give the channel a known predecessor so "Back leaves the page" is observable.
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(beta).toBeVisible();
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  const before = await entry();
  const chain = await length();
  await openSettings(page);
  // Opening writes Settings into the page's address in place: no new visit.
  const opened = await entry();
  expect(opened.target).toEqual({
    ...before.target,
    overlay: { kind: "settings" },
  });
  expect(opened.id).toBe(before.id);
  expect(await length()).toBe(chain);
  expect(await canGoForward()).toBe(false);
  // A section switch is the same visit.
  await selectSettingsSection(page, "Notifications");
  await expect
    .poll(async () => (await entry()).target.overlay)
    .toEqual({ kind: "settings", section: "notifications" });
  expect(await length()).toBe(chain);
  expect(await canGoForward()).toBe(false);
  // Back while Settings is open leaves the page; a dialog never consumes it.
  await page.goBack();
  await expect(beta).toBeVisible();
  await expect(dialog).toHaveCount(0);
  // Forward returns to the page visit; its address still carries Settings.
  await page.goForward();
  await expect(notifications).toBeVisible();
  expect(await canGoForward()).toBe(false);
  // Close rewrites the same visit: Back leaves the page and Settings is in
  // the chain in neither direction.
  await closeSettings(page);
  await expect(composer).toBeVisible();
  await expect(composer).toHaveText("Keep this draft");
  expect((await entry()).target).toEqual(before.target);
  expect(await length()).toBe(chain);
  expect(await canGoForward()).toBe(false);
  await page.goBack();
  await expect(beta).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.goForward();
  await expect(composer).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect((await entry()).target).toEqual(before.target);
  // Reload restores Settings from the address; Close returns to the page beneath.
  await openSettings(page);
  await selectSettingsSection(page, "Notifications");
  const reopened = await entry();
  await page.reload();
  await expect(notifications).toBeVisible();
  expect((await entry()).id).toBe(reopened.id);
  await closeSettings(page);
  await expect(composer).toBeVisible();
  expect((await entry()).target).toEqual(before.target);
  expect(await length()).toBe(chain);
  expect(await canGoForward()).toBe(false);
  await page.goBack();
  await expect(beta).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
