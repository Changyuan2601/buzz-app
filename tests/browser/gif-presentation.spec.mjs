import { test, expect } from "./source-fixture.mjs";

// Real layout proves full-frame paint and viewport containment; jsdom cannot.
test("sent images and extensionless GIFs keep full frames with captions and multiple attachments", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/message-gallery.html?group=gifs");
  const only = page.locator('[data-message-id="gif-only"]');
  const caption = page.locator('[data-message-id="gif-caption"]');
  const multiple = page.locator('[data-message-id="gif-multiple"]');
  const previews = page.locator("[data-message-id] [data-media-preview]");
  await expect(previews).toHaveCount(6);
  await expect(
    caption.getByText("A little celebration!", { exact: true }),
  ).toBeVisible();
  const links = multiple.locator("[data-media-preview]");
  await expect(links).toHaveCount(3);
  await expect(links.nth(1).locator("img")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml/,
  );
  const unavailable = page
    .locator('[data-message-id="gif-unavailable"]')
    .getByRole("status");
  await expect(unavailable).toHaveText("Image unavailable");

  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 });
      for (const scale of [1, 1.25]) {
        await page.evaluate((scale) => {
          document.documentElement.style.setProperty(
            "--type-rem",
            `${16 * scale}px`,
          );
        }, scale);
        for (const preview of await previews.all()) {
          await preview.scrollIntoViewIfNeeded();
          const img = preview.locator("img");
          await expect(img).toHaveCSS("visibility", "visible");
          await expect(img).toHaveCSS("object-fit", "contain");
          const bounds = await preview.boundingBox();
          expect(bounds.width).toBeGreaterThanOrEqual(1);
          expect(bounds.height).toBeGreaterThanOrEqual(1);
          const natural = await img.evaluate((el) => ({
            width: el.naturalWidth,
            height: el.naturalHeight,
          }));
          expect(bounds.width).toBeLessThanOrEqual(
            Math.min(360, natural.width),
          );
          expect(bounds.height).toBeLessThanOrEqual(
            Math.min(320, natural.height),
          );
          if (bounds.width > 1 && bounds.height > 1)
            expect(bounds.width / bounds.height).toBeCloseTo(
              natural.width / natural.height,
              2,
            );
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        const reserved = await unavailable.boundingBox();
        expect(reserved.width / reserved.height).toBeCloseTo(360 / 320, 2);
        const positions = await links.evaluateAll((elements) =>
          elements.map((el) => {
            const bounds = el.getBoundingClientRect();
            return { top: bounds.top, bottom: bounds.bottom };
          }),
        );
        for (let index = 1; index < positions.length; index++)
          expect(positions[index].top).toBeGreaterThanOrEqual(
            positions[index - 1].bottom,
          );
        const emoji = page.locator(
          '[data-message-id="emoji-wrapped"] [data-single-emoji]',
        );
        await emoji.scrollIntoViewIfNeeded();
        await expect(emoji.locator("img")).toHaveCount(6);
        await expect
          .poll(() =>
            emoji
              .locator("img")
              .evaluateAll((images) =>
                images.every(
                  (image) => image.complete && image.naturalWidth > 0,
                ),
              ),
          )
          .toBe(true);
        await page.evaluate(() => document.fonts.ready);
        const layout = await emoji.evaluate((el) => {
          const paragraph = el.getBoundingClientRect();
          return {
            top: paragraph.top,
            bottom: paragraph.bottom,
            text: [...el.childNodes]
              .filter(
                (node) =>
                  node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
              )
              .flatMap((node) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return [...range.getClientRects()].map((box) => ({
                  left: box.left,
                  right: box.right,
                }));
              }),
            images: [...el.querySelectorAll("img")].map((image) => {
              const box = image.getBoundingClientRect();
              return {
                top: box.top,
                bottom: box.bottom,
                left: box.left,
                right: box.right,
              };
            }),
          };
        });
        for (const image of layout.images) {
          expect(image.top).toBeGreaterThanOrEqual(layout.top);
          expect(image.bottom).toBeLessThanOrEqual(layout.bottom);
          expect(image.left).toBeGreaterThanOrEqual(0);
          expect(image.right).toBeLessThanOrEqual(width);
        }
        expect(layout.text.length).toBeGreaterThan(0);
        for (const text of layout.text) {
          expect(text.left).toBeGreaterThanOrEqual(0);
          expect(text.right).toBeLessThanOrEqual(width);
        }
        const lines = [...new Set(layout.images.map((image) => image.top))];
        if (width === 390) expect(lines.length).toBeGreaterThan(1);
        for (let index = 1; index < lines.length; index++)
          expect(lines[index] - lines[index - 1]).toBeGreaterThanOrEqual(
            48 * scale,
          );
      }
    }
  }

  const first = only.getByRole("link", { name: "Open image attachment" });
  await first.scrollIntoViewIfNeeded();
  await first.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(first).toBeFocused();
  await first.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(first).toBeFocused();
});
