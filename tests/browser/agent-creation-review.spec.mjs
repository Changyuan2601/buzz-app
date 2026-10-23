import { test, expect } from "./source-fixture.mjs";

test("agent creation waits for owner review in the existing editable form", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?review");
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  const name = dialog.getByPlaceholder("Name your agent");
  await expect(name).toHaveValue("Child");
  await expect(name).toBeFocused();
  await expect(dialog).toContainText(
    "Parent requested this agent. Review its settings",
  );
  expect(await page.evaluate(() => window.creationReviewResult())).toEqual([]);
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(name).toBeInViewport();
      await expect(
        dialog.getByRole("button", { name: "Create agent", exact: true }),
      ).toBeInViewport();
    }
  }
  await name.fill("Reviewed");
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.creationReviewResult())).toEqual([
    expect.objectContaining({ name: "Reviewed", type: "fixture/agent" }),
  ]);
});
