import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  historyCounts: { alpha: 1, beta: 0 },
  detailsMessage: `# Release notes\n\n${"The sidebar keeps its place while channels load. ".repeat(30)}`,
});

// Only a real engine lays the sheet out around the composer and decides which
// surface a press at the composer reaches; jsdom has neither layout nor paint.
test("details grow out of the composer, which stays usable above them", async ({
  page,
  app,
}) => {
  await open(page, app);
  const more = page.getByRole("button", { name: "Show more: Release notes" });
  await more.click();
  const sheet = page.getByRole("dialog", { name: "Release notes" });
  await expect(sheet).toBeVisible();
  const composer = page.locator("[data-message-composer]");
  // The settled sheet surrounds the composer: no growth animation is running.
  await expect
    .poll(() =>
      sheet.evaluate((element) =>
        element.getAnimations().some((a) => a.playState === "running"),
      ),
    )
    .toBe(false);
  const [outer, inner] = [
    await sheet.boundingBox(),
    await composer.boundingBox(),
  ];
  expect(outer.x).toBeLessThan(inner.x);
  expect(outer.x + outer.width).toBeGreaterThan(inner.x + inner.width);
  expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
  expect(outer.y).toBeLessThan(inner.y - 200);
  // The composer paints above the sheet and takes a reply without closing it.
  expect(
    await composer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return element.contains(hit);
    }),
  ).toBe(true);
  const reply = page.getByRole("textbox", { name: "Message #Alpha" });
  await reply.click();
  await reply.pressSequentially("Thanks");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close details" }).click();
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();
  await expect(reply).toHaveText("Thanks");
});
