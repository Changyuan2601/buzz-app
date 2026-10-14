import { test, expect } from "./source-fixture.mjs";

// The real cascade and WebKit accessibility tree require a browser. Service
// concurrency, recovery and snapshot-state permutations stay in colocated tests.
test("agent cards expose selection and creation preserves focus and selected borders", async ({
  page,
}, info) => {
  await page.goto("/tests/fixtures/agent-library.html");
  const grid = page.getByRole("grid", { name: "Agents", exact: true });
  await expect(grid.getByRole("row")).toHaveCount(3);
  const ada = grid.getByRole("gridcell", { name: "Ada", exact: true });
  await ada.focus();
  await page.keyboard.press("ArrowRight");
  await expect(ada).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(
    grid.getByRole("gridcell", { name: "Bo", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Create a new agent", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByPlaceholder("Agent name");
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.dataset.keyboardNavigation = "";
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await name.focus();
      await expect(name).toBeFocused();
      await expect
        .poll(() =>
          name.evaluate((field) => getComputedStyle(field).borderBottomColor),
        )
        .not.toBe("rgba(0, 0, 0, 0)");
      await expect(name).toBeInViewport();
      const label = dialog
        .locator(".buzz-preference-row-label")
        .filter({ hasText: /^Model$/ });
      await expect
        .poll(() =>
          label.evaluate((element) => {
            const style = getComputedStyle(element);
            return (
              element.getBoundingClientRect().height /
              Number.parseFloat(style.lineHeight)
            );
          }),
        )
        .toBeLessThan(1.5);
      await page.screenshot({
        path: info.outputPath(`creation-${theme}-${width}.png`),
      });
    }
  }
  await dialog.locator('[data-avatar-view="selected"] > div').hover();
  await dialog
    .getByRole("button", { name: "Choose avatar", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Gloopies", exact: true }).click();
  const option = dialog.locator("button[aria-pressed]").first();
  await option.click();
  await dialog.locator('[data-avatar-view="selected"] > div').hover();
  await dialog
    .getByRole("button", { name: "Choose avatar", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Gloopies", exact: true }).click();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  const selectedBorder = await option.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  await option.hover();
  await expect
    .poll(() =>
      option.evaluate((element) => getComputedStyle(element).borderColor),
    )
    .toBe(selectedBorder);
});
