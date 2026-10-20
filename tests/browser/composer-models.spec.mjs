import { test, expect } from "./source-fixture.mjs";
import { wcagRatio } from "../../scripts/design-system/apca.mjs";

// Browser-only: actual CSS Modules and the portal paint this existing slider.
// The token guard cannot catch a consumer still asking for a button-fill role.
// The composer unit tests own model discovery and sending the chosen effort.
test("effort thumb stays distinguishable without keyboard focus across appearance changes", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "light");
    localStorage.setItem("buzz-accent.v1", "chartreuse");
    localStorage.setItem("buzz-color-level.v1", "touch");
  });
  await page.goto("/tests/fixtures/composer-models.html");
  await page
    .getByRole("button", { name: "Model and effort for the next run" })
    .click();
  const slider = page.getByRole("slider", {
    name: "Effort for Honey's next run",
  });
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");

  for (const mode of ["light", "dark"]) {
    await page.locator("html").evaluate((root, mode) => {
      root.dataset.colorMode = mode;
    }, mode);
    await slider.evaluate((input) => input.blur());
    await expect(slider).not.toBeFocused();
    const thumb = slider.locator("..");
    await expect(thumb).toHaveCSS("outline-style", "none");
    const colors = await thumb.evaluate((node) => {
      const hex = (color) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return (
          "#" +
          [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("")
        );
      };
      return {
        mark: hex(getComputedStyle(node).backgroundColor),
        track: hex(getComputedStyle(node.parentElement).backgroundColor),
      };
    });
    expect(
      wcagRatio(colors.mark, colors.track),
      `unfocused effort thumb in ${mode}`,
    ).toBeGreaterThanOrEqual(3);
    await page.getByRole("dialog").screenshot({
      path: testInfo.outputPath(`effort-${mode}.png`),
    });
  }
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Model and effort for the next run" }),
  ).toBeFocused();
});
