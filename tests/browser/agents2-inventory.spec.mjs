import { test, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createServer } from "./vite-server.mjs";

// Real layout/hit testing and CSS hover/focus cannot be proved in jsdom. These
// cases complement the page's existing selection/create tests, not repeat them.
let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agents2.html`;
});
test.afterAll(async () => {
  await server?.close();
});
async function choose(page, name, option) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("single activation opens the canonical profile and native undo survives tab visits", async ({
  page,
}) => {
  await page.goto(url);
  await choose(page, "View", "Real page");
  await choose(page, "Owned agents", "3");
  const card = page.getByRole("button", { name: /codebot Sample agent/ });
  await card.click();
  await expect(
    page.getByRole("dialog", { name: "Agent profile" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const text = page.getByRole("textbox", { name: "Instructions" });
  await text.click();
  await page.keyboard.type("draft text");
  await page.getByRole("tab", { name: "Info", exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(text).toHaveValue("draft text");
  await text.focus();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  // Native engines choose their own typing transaction boundaries.
  await expect(text).not.toHaveValue("draft text");
  await text.fill("Keep this draft");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toHaveCount(0);
  await expect(text).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: /wordbot Sample agent/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Agent profile" }),
  ).toBeVisible();
});

test("secondary add reveals on focus and stays available on touch", async ({
  page,
}) => {
  await page.goto(url);
  const action = page.getByRole("button", { name: "Add codebot", exact: true });
  await expect(action).toBeAttached();
  await expect
    .poll(() =>
      action.evaluate((el) => getComputedStyle(el.parentElement).opacity),
    )
    .toBe("0");
  await action.focus();
  await expect
    .poll(() =>
      action.evaluate((el) => getComputedStyle(el.parentElement).opacity),
    )
    .toBe("1");
  await action.press("Enter");
  await expect(page.getByRole("status")).toHaveText(
    "codebot added to this preview only.",
  );
  const context = await page
    .context()
    .browser()
    .newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
  try {
    const touch = await context.newPage();
    await touch.goto(url);
    const add = touch.getByRole("button", { name: "Add codebot", exact: true });
    await expect
      .poll(() =>
        add.evaluate((el) => getComputedStyle(el.parentElement).opacity),
      )
      .toBe("1");
    await add.tap();
    await expect(touch.getByRole("status")).toHaveText(
      "codebot added to this preview only.",
    );
  } finally {
    await context.close();
  }
});
