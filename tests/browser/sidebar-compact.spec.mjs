import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { opened } from "./menu-motion.mjs";

test.use({
  productionBroker: true,
  savedSidebar: true,
  channelIds: ["alpha", "beta"],
  channelNames: { alpha: "General", beta: "Planning" },
  historyCounts: { alpha: 1, beta: 1 },
});

// Real paint, pointer hit testing and portalled focus/collision cannot be proved in jsdom.
for (const width of [1280, 520]) {
  for (const theme of ["light", "dark"]) {
    test(`compact rail and section flyout at ${width}px in ${theme}`, async ({
      page,
      app,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(app.origin);
      await openPage(page, "Messages");
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
      }, theme);
      if (width < 650)
        await page
          .getByRole("button", { name: "Show navigation", exact: true })
          .click();
      await expect(
        page.locator('[data-sidebar-section="channels"]'),
      ).toBeVisible();
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().endTime !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      await page.screenshot({ path: info.outputPath("full-sidebar.png") });
      const choose = async (name) => {
        await page
          .getByRole("button", { name: "Sidebar presentation", exact: true })
          .click();
        await page.getByRole("menuitemradio", { name, exact: true }).click();
      };
      await choose("Compact rail");
      const rail = page.locator(".shell-sidebar");
      await expect(rail).toBeVisible();
      await expect
        .poll(async () => (await rail.boundingBox())?.width)
        .toBeLessThan(100);
      await expect(
        page.getByRole("separator", { name: "Resize sidebar" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Inbox", exact: true }),
      ).toBeVisible();
      const trigger = page.getByRole("button", {
        name: "Starred",
        exact: true,
      });
      await trigger.hover();
      const popup = page.getByRole("dialog", { name: "Starred", exact: true });
      await expect(popup).toBeVisible();
      await expect(popup.locator('[data-channel-id="alpha"]')).toBeVisible();
      await opened(popup);
      await page.screenshot({ path: info.outputPath("compact-rail.png") });
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await trigger.click();
      const work = page.getByRole("button", { name: "Work", exact: true });
      await work.hover();
      const workPopup = page.getByRole("dialog", { name: "Work", exact: true });
      await expect(workPopup).toBeVisible();
      await expect(popup).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(workPopup).toBeHidden();
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(popup).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "150%";
      });
      await expect
        .poll(async () => {
          const box = await popup.boundingBox();
          return box && box.x >= 0 && box.x + box.width <= width;
        })
        .toBe(true);
      const row = popup.locator('[data-channel-id="alpha"]');
      await expect
        .poll(() =>
          row.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              ),
            );
          }),
        )
        .toBe(true);
      await row.click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: "Mark as Unread", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(row).toBeFocused();
      await popup.locator('[data-channel-id="alpha"]').click();
      await expect(
        page.getByRole("textbox", { name: "Message #General", exact: true }),
      ).toBeVisible();
      await expect(popup).toBeHidden();
      await page.reload();
      await expect(rail).toBeVisible();
      await expect
        .poll(async () => (await rail.boundingBox())?.width)
        .toBeLessThan(100);
      await trigger.click();
      await expect(popup).toBeVisible();
      await choose("Collapsed sidebar");
      await expect(page.locator("#shell-navigation")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      await choose("Compact rail");
      await expect(popup).toBeHidden();
      await trigger.click();
      await expect(popup).toBeVisible();
      await choose("Full sidebar");
      await choose("Compact rail");
      await expect(popup).toBeHidden();
      await choose("Full sidebar");
      await expect
        .poll(async () => (await rail.boundingBox())?.width)
        .toBeGreaterThanOrEqual(220);
    });
  }
}
