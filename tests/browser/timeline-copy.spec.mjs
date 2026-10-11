import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true });

// Browser-only contract: a native pointer selection across a mention button and
// a channel anchor, serialized by each engine's real copy event. The walker's
// case matrix lives in src/features/messages/selection-copy.test.tsx.
test("copying a timeline selection keeps mentions, channel refs and links in both flavors", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Ping @Fixture Reader about #Beta and https://example.test/docs",
    true,
    true,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(
    row.getByRole("button", { name: "View Fixture Reader profile" }),
  ).toBeVisible();
  await expect(row.getByRole("link", { name: "#Beta" })).toBeVisible();
  const paragraph = row.locator("p").first();
  const box = await paragraph.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  test.info().annotations.push({
    type: "pointer selection",
    description: JSON.stringify(selected),
  });
  expect(selected).toBe(
    "Ping Fixture Reader about Beta and https://example.test/docs",
  );
  await page.evaluate(() => {
    window.__copyPayload = undefined;
    document.addEventListener(
      "copy",
      (event) => {
        window.__copyPayload = {
          prevented: event.defaultPrevented,
          text: event.clipboardData?.getData("text/plain"),
          html: event.clipboardData?.getData("text/html"),
        };
      },
      { once: true },
    );
  });
  if (browserName === "webkit") {
    // Headless WebKit does not dispatch Copy for selected non-editable content
    // from keyboard input on Linux; the browser copy command uses the real
    // selection and document listeners rather than a synthetic event.
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  } else {
    await page.keyboard.press("ControlOrMeta+c");
  }
  await expect
    .poll(() => page.evaluate(() => window.__copyPayload))
    .toEqual({
      prevented: true,
      text: "Ping @Fixture Reader about #Beta and https://example.test/docs",
      html: `<div data-buzz-copy="timeline"><p>Ping <a href="nostr:${npubEncode(app.viewer)}">@Fixture Reader</a> about <a href="buzz://channel/beta">#Beta</a> and <a href="https://example.test/docs">https://example.test/docs</a></p></div>`,
    });
});
