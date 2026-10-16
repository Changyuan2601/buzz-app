import { test, expect } from "./source-fixture.mjs";
import { BUBBLE_COLORS } from "../../src/shared/theme/bubble-color.ts";
import { apcaContrast, wcagRatio } from "../../scripts/design-system/apca.mjs";

const specimen = (page, id) => page.locator(`[aria-labelledby="label-${id}"]`);
// macOS WebKit follows the host preference: Option-Tab includes every control.
const tabKey = (browserName) =>
  browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";

// Browser-only: composite translucent fills to check text contrast, and check
// overflow. A DOM emulator cannot prove these bubble contracts.
async function paint(locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const hex = () =>
      `#${[...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
    const parents = [];
    for (let node = element; node; node = node.parentElement)
      parents.push(node);
    for (const node of parents.reverse()) {
      context.fillStyle = getComputedStyle(node).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const background = hex();
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    return { background, ink: hex() };
  });
}
async function expectReadable(locator) {
  const { background, ink } = await paint(locator);
  expect(
    wcagRatio(background, ink),
    `${ink} on ${background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

for (const theme of ["light", "dark"]) {
  test(`message references and inset surfaces remain legible in ${theme}`, async ({
    page,
    browserName,
  }, info) => {
    await page.goto(
      `/tests/fixtures/message-gallery.html?group=references&theme=${theme}`,
    );
    await page.evaluate(() => document.fonts.ready);
    const received = specimen(page, "references-received");
    const own = specimen(page, "references-own");
    const table = specimen(page, "table-links").getByRole("table");
    const receivedLink = received.getByRole("link", {
      name: "the design notes",
      exact: true,
    });
    const ownLink = own.getByRole("link", {
      name: "the design notes",
      exact: true,
    });
    const mention = own.getByRole("button", {
      name: "View Sam Rivera profile",
      exact: true,
    });
    await own
      .getByRole("button", { name: "Reveal spoiler", exact: true })
      .click();
    const spoiler = own.locator('[data-revealed="true"]');
    await expect(
      spoiler.getByRole("link", { name: "release notes", exact: true }),
    ).toBeVisible();

    for (const color of BUBBLE_COLORS) {
      await page.locator("html").evaluate((element, color) => {
        element.dataset.bubbleColor = color;
      }, color);
      await page.mouse.move(0, 0);
      const bubble = own.locator("[data-message-action-anchor][data-own]");
      const bodyPaint = await paint(bubble);
      expect(
        Math.abs(apcaContrast(bodyPaint.ink, bodyPaint.background)),
      ).toBeGreaterThanOrEqual(60);
      await expectReadable(bubble);
      for (const link of [receivedLink, ownLink]) {
        await expectReadable(link);
        await link.hover();
        await expectReadable(link);
      }
      await expectReadable(mention);
      await mention.hover();
      await expectReadable(mention);
      await expectReadable(spoiler);
      await expectReadable(
        spoiler.getByRole("link", { name: "release notes", exact: true }),
      );
      if (color === "neutral") {
        await page.mouse.move(0, 0);
        await own.screenshot({
          path: info.outputPath(`neutral-message-${theme}.png`),
        });
      }
      await expectReadable(
        table.getByRole("cell", { name: "Ready", exact: true }),
      );
      await expectReadable(
        table.getByRole("link", { name: "Design notes", exact: true }),
      );
      await expectReadable(
        specimen(page, "code-diff").getByText("greeting.ts", { exact: true }),
      );
    }
    // Real keyboard input reaches and activates the link.
    await received.locator('button[data-mention-kind="person"]').focus();
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press(tabKey(browserName));
    await expect(receivedLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(received.getByRole("status")).toContainText(
      "Sample link selected",
    );
    await page
      .getByRole("button", { name: "Narrow preview", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator(".message-gallery-frame")
          .evaluateAll((frames) =>
            frames.every((frame) => frame.scrollWidth <= frame.clientWidth),
          ),
      )
      .toBe(true);
    await received.screenshot({
      path: info.outputPath(`message-references-${theme}.png`),
    });
  });
}

test("file anchors and native download buttons stay readable and keyboard reachable", async ({
  page,
  browserName,
}) => {
  await page.goto("/tests/fixtures/message-gallery.html?group=attachments");
  const external = specimen(page, "file").getByRole("link", {
    name: "Open design-review-notes.txt",
    exact: true,
  });
  const download = specimen(page, "file-download").getByRole("button", {
    name: "Download review-notes.txt",
    exact: true,
  });
  for (const control of [external, download]) {
    await control.hover();
    await expectReadable(control);
  }
  await specimen(page, "file-download")
    .getByRole("button", { name: "More message actions", exact: true })
    .focus();
  await page.keyboard.press(tabKey(browserName));
  await expect(download).toBeFocused();
  await page
    .getByRole("button", { name: "Narrow preview", exact: true })
    .click();
  await page.getByRole("button", { name: "All messages", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workflow attribution", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".message-gallery-frame")
        .evaluateAll((frames) =>
          frames.every((frame) => frame.scrollWidth <= frame.clientWidth),
        ),
    )
    .toBe(true);
});
