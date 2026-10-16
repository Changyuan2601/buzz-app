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
  await expect(name).toBeFocused();
  await expect
    .poll(() =>
      name.evaluate((field) => getComputedStyle(field).borderBottomColor),
    )
    .toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: info.outputPath("creation-pointer-focus.png"),
  });
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 768, 1280]) {
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
      const instructions = dialog.getByRole("textbox", {
        name: "Instructions",
        exact: true,
      });
      await expect(instructions).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(instructions.locator("..")).not.toHaveClass(
        /buzz-settings-group/,
      );
      await instructions.focus();
      await expect(instructions).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect
        .poll(() =>
          instructions.evaluate(
            (element) => getComputedStyle(element).borderBottomColor,
          ),
        )
        .not.toBe("rgba(0, 0, 0, 0)");
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

test("owner profile keeps its pane and caret stable during inline name editing", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/fixtures/agent-library.html");
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  const profile = page.getByRole("region", {
    name: "Agent profile",
    exact: true,
  });
  const agents = page.getByRole("region", { name: "Agents", exact: true });
  expect((await profile.boundingBox()).y).toBe((await agents.boundingBox()).y);
  const divider = page.getByRole("separator", {
    name: "Resize main and secondary panels",
  });
  const originalWidth = (await profile.boundingBox()).width;
  const originalListWidth = (await agents.boundingBox()).width;
  const handle = await divider.boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handle.x - 100, handle.y + handle.height / 2);
  await page.mouse.up();
  await expect
    .poll(async () => (await profile.boundingBox()).width)
    .toBeGreaterThan(originalWidth + 80);
  expect((await agents.boundingBox()).width).toBeLessThan(
    originalListWidth - 80,
  );
  await divider.focus();
  const draggedWidth = (await profile.boundingBox()).width;
  await divider.press("ArrowRight");
  await expect
    .poll(async () => (await profile.boundingBox()).width)
    .toBeLessThan(draggedWidth);
  const adaCard = agents.getByRole("gridcell", { name: "Ada", exact: true });
  const portrait = adaCard.locator('span[aria-hidden="true"]').first();
  const widePortrait = (await portrait.boundingBox()).width;
  await divider.press("End");
  const agentGrid = agents.getByRole("grid", { name: "Agents", exact: true });
  await expect
    .poll(() =>
      agentGrid.evaluate(
        (element) =>
          getComputedStyle(element.parentElement).gridTemplateColumns.split(" ")
            .length,
      ),
    )
    .toBe(1);
  expect((await portrait.boundingBox()).width).toBeLessThan(widePortrait);
  expect(
    await agentGrid.evaluate(
      (element) =>
        element.parentElement.scrollWidth <= element.parentElement.clientWidth,
    ),
  ).toBe(true);
  await adaCard.focus();
  await adaCard.press("ArrowDown");
  await expect(
    agents.getByRole("gridcell", { name: "Bo", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await divider.dblclick();
  await expect
    .poll(async () => (await profile.boundingBox()).width)
    .toBe(originalWidth);

  await page.getByRole("tab", { name: "Attention", exact: true }).click();
  await expect(
    profile.getByRole("heading", { name: "Interests" }),
  ).toBeVisible();
  const before = await profile.boundingBox();
  await page.screenshot({ path: info.outputPath("agent-profile.png") });
  await profile.getByRole("button", { name: "Agent profile actions" }).click();
  await page.getByRole("menuitem", { name: "Change name" }).click();
  const input = profile.getByRole("textbox", { name: "Agent name" });
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      input.evaluate((element) => getComputedStyle(element).borderBottomColor),
    )
    .toBe("rgba(0, 0, 0, 0)");
  await expect
    .poll(() => input.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([3, 3]);
  expect((await profile.boundingBox()).height).toBe(before.height);
  await page.screenshot({
    path: info.outputPath("name-edit-pointer-focus.png"),
  });
  // This isolated fixture does not install the app's modality tracker.
  await page.evaluate(() => {
    document.documentElement.dataset.keyboardNavigation = "";
  });
  await input.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      input.evaluate((field) => getComputedStyle(field).borderBottomColor),
    )
    .not.toBe("rgba(0, 0, 0, 0)");
  await input.fill("Ada renamed");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    profile.getByRole("heading", { name: "Ada", exact: true }),
  ).toBeVisible();
  expect((await profile.boundingBox()).height).toBe(before.height);
});
