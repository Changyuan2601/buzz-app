import { test, expect } from "./source-fixture.mjs";

// Real layout, computed surfaces, stacking and pointer/focus tooltip behavior.
test("standalone content and compact message metadata", async ({ page }) => {
  await page.goto("/tests/fixtures/message-gallery.html?bubble=blue");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    for (const id of ["table-links", "code-diff"]) {
      const bubble = page.locator(
        `[data-message-id="${id}"] [data-message-action-anchor]`,
      );
      await expect(bubble).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(bubble).toHaveCSS("padding-top", "0px");
    }
    const file = page.getByRole("button", {
      name: "Download review-notes.txt",
      exact: true,
    });
    await expect(file.locator('[data-kind="text"]')).toBeVisible();
    await expect(
      page.locator('[data-message-id="file-unavailable"] [data-kind="pdf"]'),
    ).toBeVisible();
    const retry = page
      .locator('[data-message-id="delivery-failed"]')
      .getByRole("button", { name: "Retry", exact: true });
    await retry.hover();
    await expect(page.getByRole("tooltip")).toContainText("Couldn’t send");
    await page.mouse.move(0, 0);
    await retry.focus();
    await expect(page.getByRole("tooltip")).toContainText("Couldn’t send");
    await retry.press("Tab");
  }
  const avatars = page.locator(
    '[data-message-id="thread"] [data-avatar-stack] > [data-avatar-shape]',
  );
  await expect(avatars).toHaveCount(3);
  for (let index = 0; index < 3; index++)
    await expect(avatars.nth(index)).toHaveCSS("z-index", String(index + 1));
});
