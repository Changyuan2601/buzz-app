import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

import { holdMenuExit, opened } from "./menu-motion.mjs";

test("closing a menu keeps focus where the user moved it", async ({
  page,
  app,
}) => {
  await open(page, app);
  const exit = await holdMenuExit(page);
  const row = page
    .getByRole("navigation", {
      name: "Subscribed channels",
      includeHidden: true,
    })
    .locator('[data-channel-id="beta"]');
  const rowMenu = page.getByRole("menu", { name: "Actions for Beta" });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });

  try {
    await row.click({ button: "right" });
    await opened(rowMenu);
    await page.keyboard.press("Escape");
    await exit.held(rowMenu);
    await composer.click();
    await expect(composer).toBeFocused();
    await expect(rowMenu).toHaveCount(1);
    await exit.release();
    // The row menu has finished closing. Its explicit final focus (the row)
    // must not pull focus back out of the composer.
    await expect(rowMenu).toHaveCount(0);
    await expect(composer).toBeFocused();

    // A collapsed disclosure (Base UI marks it data-closed, like a closing
    // popup) is ordinary page content. Focus moved into it also stays.
    await page.evaluate(() => {
      const collapsed = document.createElement("div");
      collapsed.setAttribute("data-closed", "");
      collapsed.innerHTML = '<button type="button">Collapsed control</button>';
      document.getElementById("main-content").append(collapsed);
    });
    const collapsedControl = page.getByRole("button", {
      name: "Collapsed control",
    });
    await row.click({ button: "right" });
    await opened(rowMenu);
    await page.keyboard.press("Escape");
    await exit.held(rowMenu);
    await collapsedControl.focus();
    await expect(rowMenu).toHaveCount(1);
    await exit.release();
    await expect(rowMenu).toHaveCount(0);
    await expect(collapsedControl).toBeFocused();

    // With nothing else focused, Escape still returns focus to the row.
    await row.click({ button: "right" });
    await opened(rowMenu);
    await page.keyboard.press("Escape");
    await exit.held(rowMenu);
    await exit.release();
    await expect(rowMenu).toHaveCount(0);
    await expect(row).toBeFocused();
  } finally {
    await exit.release();
  }
});

// Browser-only boundary: the right-click's mousedown focuses the rail button
// before the contextmenu event opens the menu, so Base UI's own "previous
// focus" is the button. jsdom moves no focus on a right-click, so only a real
// engine shows the caret leaving the composer for the rail.
test("dismissing a community menu opened by pointer returns focus to the interrupted composer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const secondary = page
    .getByRole("navigation", { name: "Communities" })
    .getByRole("button", { name: "Switch to Secondary" });
  const menu = page.getByRole("menu", { name: "Actions for Secondary" });

  await composer.click();
  await expect(composer).toBeFocused();
  await secondary.click({ button: "right" });
  await opened(menu);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(secondary).not.toBeFocused();

  // A keyboard open came from the rail, so dismissing it returns focus there.
  await secondary.focus();
  await page.keyboard.press("Shift+F10");
  await opened(menu);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(secondary).toBeFocused();
});
