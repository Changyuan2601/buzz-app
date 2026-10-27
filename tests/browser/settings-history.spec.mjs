import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ pluginFixtures: true });

// Native traversal and reload over the real address require a browser. The
// section matrix and retained-workspace lifecycle live in colocated unit tests.
test("Settings sections traverse and reload while opening and closing add no visit", async ({
  page,
  app,
  browserName,
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
  const appearance = page.getByRole("region", {
    name: "Appearance",
    exact: true,
  });
  const dialog = settingsDialog(page);
  const traverse = async (direction) => {
    if (browserName !== "chromium")
      return direction === "back" ? page.goBack() : page.goForward();
    // Chromium's native XButton path matches mouse Back/Forward buttons.
    const cdp = await page.context().newCDPSession(page);
    try {
      for (const type of ["mousePressed", "mouseReleased"])
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          x: 20,
          y: 20,
          button: direction,
          buttons: type === "mouseReleased" ? 0 : direction === "back" ? 8 : 16,
          clickCount: 1,
        });
    } finally {
      await cdp.detach();
    }
  };
  const entry = () => page.evaluate(() => history.state.buzzNavigationV1.entry);
  const length = () => page.evaluate(() => history.length);
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(beta).toBeVisible();
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  const before = await entry();
  const chain = await length();
  await openSettings(page);
  await expect
    .poll(async () => (await entry()).target.overlay?.section)
    .toBeTruthy();
  const opened = await entry();
  expect(opened.id).toBe(before.id);
  expect(await length()).toBe(chain);
  // The selected default is canonical, so selecting it again adds no visit.
  const initial = opened.target.overlay.section;
  await selectSettingsSection(
    page,
    initial === "profile" ? "Profile" : "Appearance",
  );
  expect((await entry()).id).toBe(opened.id);
  expect(await length()).toBe(chain);
  await selectSettingsSection(page, "Appearance");
  const first = await entry();
  const firstLength = await length();
  await selectSettingsSection(page, "Notifications");
  const second = await entry();
  expect(second.id).not.toBe(first.id);
  expect(await length()).toBe(firstLength + 1);
  await traverse("back");
  await expect(appearance).toBeVisible();
  expect(await entry()).toEqual(first);
  await expect(dialog).toBeVisible();
  await traverse("forward");
  await expect(notifications).toBeVisible();
  expect(await entry()).toEqual(second);
  await page.reload();
  await expect(notifications).toBeVisible();
  expect(await entry()).toEqual(second);
  // Close changes the active visit rather than appending a modal-close stop.
  const beforeClose = await length();
  await closeSettings(page);
  await expect(composer).toBeVisible();
  expect((await entry()).target).toEqual(before.target);
  expect((await entry()).id).toBe(second.id);
  expect(await length()).toBe(beforeClose);
  // Start a fresh visit for the first-section boundary: Back leaves the page
  // and Forward restores Settings, matching ordinary dialog presentation.
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(beta).toBeVisible();
  await openSettings(page);
  const firstSection = await entry();
  await traverse("back");
  await expect(composer).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await traverse("forward");
  await expect(dialog).toBeVisible();
  expect(await entry()).toEqual(firstSection);
  await closeSettings(page);
  await traverse("back");
  await expect(composer).toBeVisible();
  await traverse("forward");
  await expect(beta).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
