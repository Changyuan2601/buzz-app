import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only: the actual composer → sent MessageRow proves quotes stay inside
// the message column, and forced colors keep the quote bar visible.
test("sent quotes stay contained and keep their bar in forced colors", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  await input.fill("hello this is a quote");
  await page
    .getByRole("button", { name: "Toggle formatting", exact: true })
    .click();
  await page.getByRole("button", { name: "Quote", exact: true }).click();
  await expect(input.locator("blockquote")).toHaveText("hello this is a quote");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const preview = page.getByRole("region", { name: "Sent message preview" });
  await expect(preview.locator("blockquote")).toHaveText(
    "hello this is a quote",
  );
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.at(-1).text),
  ).toBe("> hello this is a quote");

  async function checkContainment() {
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(() => document.fonts.ready);
      for (const quote of await preview.locator("blockquote").all()) {
        const box = await quote.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
  }
  await checkContainment();
  await testInfo.attach("single-line-quote", {
    body: await preview.screenshot(),
    contentType: "image/png",
  });

  await input.fill("");
  await input.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      "text/html",
      '<div data-buzz-copy="timeline"><p>Before</p><blockquote><p>First quoted paragraph that wraps naturally in a narrow message column without extra space above it.</p><p>Second paragraph</p><blockquote><p>Nested quote</p></blockquote><ul><li>Quoted list item</li></ul></blockquote><p>After</p></div>',
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect(input).toContainText("Nested quote");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(preview.locator("blockquote")).toHaveCount(2);
  await expect(preview.locator("p").first()).toHaveText("Before");
  await expect(preview.locator("p").last()).toHaveText("After");
  await checkContainment();
  // Chromium models Windows/WebView2 High Contrast; WebKit has no emulation.
  if (page.context().browser().browserType().name() === "chromium") {
    await page.emulateMedia({ forcedColors: "active" });
    expect(
      await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
    ).toBe(true);
    for (const quote of await preview.locator("blockquote").all()) {
      const textColor = await quote.evaluate(
        (element) => getComputedStyle(element).color,
      );
      await expect
        .poll(() =>
          quote.evaluate(
            (element) => getComputedStyle(element, "::before").backgroundColor,
          ),
        )
        .toBe(textColor);
    }
    await page.emulateMedia({ forcedColors: "none" });
  }
  expect(errors.unexplained()).toEqual([]);
});
