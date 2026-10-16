import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only: the actual composer → sent MessageRow proves quote-bar geometry,
// wrapping and nested block margins. jsdom cannot measure these CSS contracts.
test("sent quotes fit their content and retain internal paragraph spacing", async ({
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

  async function checkGeometry() {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
      }, theme);
      for (const width of [390, 800, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(() => document.fonts.ready);
        const messageColor = await preview
          .locator("blockquote")
          .first()
          .evaluate((element) => getComputedStyle(element.parentElement).color);
        for (const quote of await preview.locator("blockquote").all()) {
          await expect(quote).toHaveCSS("color", messageColor);
          await expect(quote.locator(":scope > p").first()).toHaveCSS(
            "color",
            messageColor,
          );
          await expect(quote.locator(":scope > :first-child")).toHaveCSS(
            "margin-top",
            "0px",
          );
          await expect(quote.locator(":scope > :last-child")).toHaveCSS(
            "margin-bottom",
            "0px",
          );
          const geometry = await quote.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const first = element.firstElementChild.getBoundingClientRect();
            const last = element.lastElementChild.getBoundingClientRect();
            const style = getComputedStyle(element);
            const bar = getComputedStyle(element, "::before");
            return {
              barWidth: Number.parseFloat(bar.width),
              barHeight: Number.parseFloat(bar.height),
              barRadius: Number.parseFloat(bar.borderTopLeftRadius),
              barColor: bar.backgroundColor,
              quoteHeight: box.height,
              topGap: first.top - box.top,
              bottomGap: box.bottom - last.bottom,
              paddingTop: Number.parseFloat(style.paddingTop),
              paddingBottom: Number.parseFloat(style.paddingBottom),
              left: box.left,
              right: box.right,
            };
          });
          expect(geometry.barWidth).toBe(3);
          expect(geometry.barHeight).toBeCloseTo(geometry.quoteHeight, 1);
          expect(geometry.barRadius).toBeGreaterThanOrEqual(
            geometry.barWidth / 2,
          );
          expect(geometry.barColor).toBe(
            theme === "light"
              ? "color(srgb 0.705882 0.705882 0.705882)"
              : "color(srgb 0.294118 0.294118 0.294118)",
          );
          expect(geometry.topGap).toBeCloseTo(geometry.paddingTop, 1);
          expect(geometry.bottomGap).toBeCloseTo(geometry.paddingBottom, 1);
          expect(geometry.left).toBeGreaterThanOrEqual(0);
          expect(geometry.right).toBeLessThanOrEqual(width);
        }
      }
    }
  }
  await checkGeometry();
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
  const outer = preview.locator("blockquote").first();
  await expect(outer.locator(":scope > p").nth(1)).toHaveCSS(
    "margin-top",
    "16px",
  );
  await expect(preview.locator("p").first()).toHaveText("Before");
  await expect(preview.locator("p").last()).toHaveText("After");
  await checkGeometry();
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
