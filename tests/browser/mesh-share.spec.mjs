import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only boundary: the real sharing page, model Select popup and narrow
// geometry. Synthetic IPC does not certify SDK serving or live agent replies.
test("sharing page presents the ladder and supports share/stop at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mesh-share.html`,
    );
    const picker = page.getByRole("combobox", { name: "Model to share" });
    await expect(picker).toContainText("Auto");
    await expect(picker.locator("[title]")).toHaveAttribute(
      "title",
      "unsloth/Qwen3.8-27B-GGUF:Q4_K_M",
    );
    await picker.click();
    await expect(
      page.getByRole("option", { name: /Qwen 27B — recommended/ }),
    ).toBeVisible();
    await expect(page.getByRole("option", { name: /Gemma E4B/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Qwen 9B/ })).toBeVisible();
    await page.getByRole("option", { name: /Qwen 27B/ }).click();
    await page
      .getByRole("switch", { name: "Share compute", exact: true })
      .click();
    await expect(
      page.getByRole("switch", { name: "Share compute", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      await page.evaluate(
        () =>
          window.meshShareFixture.calls.find(
            (call) => call.command === "mesh_compute_share",
          ).args.model,
      ),
    ).toBe("unsloth/Qwen3.8-27B-GGUF:Q4_K_M");
    for (const [width, mode] of [
      [1200, "light"],
      [390, "dark"],
    ]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        mode,
      );
      await expect(
        page.getByRole("switch", { name: "Share compute", exact: true }),
      ).toBeInViewport();
      await expect
        .poll(() =>
          page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main div:not(.sr-only), main section",
              ),
            ].every(
              (element) => element.scrollWidth <= element.clientWidth + 1,
            ),
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`sharing-${width}-${mode}.png`),
        fullPage: true,
      });
    }
    await page
      .getByRole("switch", { name: "Share compute", exact: true })
      .click();
    await expect(
      page.getByRole("switch", { name: "Share compute", exact: true }),
    ).toHaveAttribute("aria-checked", "false");
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only boundary: native-page wiring, create-dialog keyboard/focus and
// responsive geometry. Agent creation is synthetic; no host signing claim.
test("main Shared compute helpers open an editable owner-reviewed creation flow", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mesh-share.html`,
    );
    for (const name of [
      "Emoji maker",
      "Media converter",
      "Thread summarizer",
      "Translator",
      "Custom agent",
    ])
      await expect(
        page.getByRole("button", { name: `Set up ${name}` }),
      ).toBeEnabled();
    await page.getByRole("button", { name: "Set up Translator" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create agent" });
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      "Translator",
    );
    await dialog.getByLabel("Instructions").fill("Translate into French.");
    await dialog.getByRole("combobox", { name: "Mode" }).click();
    await page
      .getByRole("option", { name: "Agent — goose with shell and files" })
      .click();
    await dialog.getByRole("checkbox", { name: /Buzz access/ }).click();
    await dialog.getByLabel("Workspace", { exact: true }).fill("/tmp/helpers");
    for (const width of [390, 1200])
      for (const mode of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate((mode) => {
          document.documentElement.setAttribute("data-color-mode", mode);
          document.documentElement.style.fontSize = "20px";
        }, mode);
        await expect(
          dialog.getByRole("button", { name: "Create agent" }),
        ).toBeInViewport();
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`helper-${width}-${mode}.png`),
          fullPage: true,
        });
      }
    expect(
      await page.evaluate(() => window.meshHelperFixture.created.length),
    ).toBe(0);
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(() => window.meshHelperFixture.created[0]),
    ).toMatchObject({
      name: "Translator",
      config: {
        prompt: "Translate into French.",
        mode: "agent",
        buzz: false,
        workspace: "/tmp/helpers",
      },
    });
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
