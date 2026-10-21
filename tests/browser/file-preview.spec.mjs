import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { readFile } from "node:fs/promises";

const markdown =
  "# Preview works\n\nA **Markdown** file in Buzz.\n\n| Format | Ready |\n| --- | --- |\n| Markdown | Yes |\n\n```js\nconst preview = true;\n```\n";
const filename = "BLOX_IDLE_RESIZE_FRESH_IMPLEMENTATION_BRIEF_V3_2026_10_21.md";
const url = `https://primary.example/media/${"a".repeat(64)}.md`;

test.use({
  channelIds: ["htian-playground"],
  channelNames: { "htian-playground": "htian-playground" },
  historyCounts: { "htian-playground": 1 },
  mediaFiles: { [url]: markdown },
});

// Real panel dispatch, keyboard activation, and narrow layout require a browser.
test("sent Markdown files open in the panel host and fit enlarged narrow layouts", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "htian-playground", exact: true })
    .click();
  await expect
    .poll(() =>
      app.report.streamInterests.some(
        (entry) =>
          entry.community === "primary" &&
          entry.channels.includes("htian-playground"),
      ),
    )
    .toBe(true);
  const event = app.append(
    "primary",
    "htian-playground",
    "Here are the implementation notes.",
    true,
    false,
    undefined,
    undefined,
    [
      [
        "imeta",
        `url ${url}`,
        "m text/markdown",
        `filename ${filename}`,
        `size ${Buffer.byteLength(markdown)}`,
      ],
    ],
  );
  const trigger = page
    .locator(`[data-message-id="${event.id}"]`)
    .getByRole("button", { name: `Preview ${filename}`, exact: true });
  const fileDownload = page
    .locator(`[data-message-id="${event.id}"]`)
    .getByRole("link", { name: `Download ${filename}`, exact: true });
  const row = page.locator(`[data-message-id="${event.id}"]`);
  const actions = row.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  const caption = row.locator("[data-message-action-anchor]").first();
  await caption.hover();
  await expect
    .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
    .toBe(true);
  await fileDownload.hover();
  await expect
    .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
    .toBe(false);
  const tooltip = page.getByRole("tooltip", { name: `Download ${filename}` });
  await expect(tooltip).toBeVisible();
  // Native popovers paint above ordinary portals; verify the filename is not covered.
  await expect
    .poll(() =>
      tooltip.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return !document
          .elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          .some((element) => element.closest('[aria-label="Message actions"]'));
      }),
    )
    .toBe(true);
  const downloadStarted = page.waitForEvent("download");
  await fileDownload.click();
  const saved = await downloadStarted;
  expect(saved.suggestedFilename()).toBe(filename);
  expect(await readFile(await saved.path(), "utf8")).toBe(markdown);
  await expect(
    page.getByRole("region", { name: `Preview: ${filename}`, exact: true }),
  ).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const preview = page.getByRole("region", {
    name: `Preview: ${filename}`,
    exact: true,
  });
  await expect(
    preview.getByRole("heading", { name: "Preview works" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close File preview tab", exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  await trigger.click();
  const download = preview.getByRole("link", { name: `Download ${filename}` });
  await expect(download).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 480, height: 850 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "150%";
  });
  await expect(
    preview.getByRole("heading", { name: "Preview works" }),
  ).toBeVisible();
  await expect(download).toBeInViewport({ ratio: 1 });
  await expect
    .poll(async () => {
      const bounds = await download.boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 480;
    })
    .toBe(true);
});
