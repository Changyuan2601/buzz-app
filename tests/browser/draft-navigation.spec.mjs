import { test, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createServer } from "./vite-server.mjs";

let server, url;
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/draft-navigation.html`;
});
test.afterAll(async () => {
  await server?.close();
});

// Native history events are asynchronous and can arrive twice per traversal.
// A fake synchronous history cannot establish this ordering or DOM retention.
test("native Back and hash edits keep the exact editor until discard", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Instructions" });
  await input.fill("Keep my draft");
  await page.evaluate(() => history.back());
  await expect(
    page.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await expect(page.locator('[role="status"]')).toContainText("appearance");
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(input).toHaveValue("Keep my draft");
  await page.evaluate(() => {
    location.hash = `#buzz=${encodeURIComponent(JSON.stringify({ version: 1, kind: "settings", section: "agents" }))}`;
  });
  await expect(
    page.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(input).toHaveValue("Keep my draft");
  await page.evaluate(() => history.forward());
  await expect(
    page.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("status")).toContainText("agents");
  await expect(input).toHaveValue("");
});

test("native Back across history chains restores toward the retained draft", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => {
    const target = (section) => ({ version: 1, kind: "settings", section });
    const state = (chain, section) => ({
      buzzNavigationV1: {
        chain,
        index: 0,
        entry: { id: chain, target: target(section) },
      },
    });
    history.replaceState(
      state("foreign", "agents"),
      "",
      `#buzz=${encodeURIComponent(JSON.stringify(target("agents")))}`,
    );
    history.pushState(
      state("current", "appearance"),
      "",
      `#buzz=${encodeURIComponent(JSON.stringify(target("appearance")))}`,
    );
  });
  await page.reload();
  await page.getByRole("textbox", { name: "Instructions" }).fill("Keep me");
  await page.evaluate(() => history.back());
  await expect(
    page.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toContain("appearance");
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "Keep me",
  );
});
