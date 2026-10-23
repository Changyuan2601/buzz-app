import { test, expect } from "./source-fixture.mjs";

test.use({ builderlabOrigin: "https://app.builderlabstaging.xyz" });

// Browser integration: the real Cordis component proxy must not remount the
// registered Apps panel as sibling tabs change. Native guest I/O is substituted.
test("Apps keeps its last native URL after Cordis rerenders and pool eviction", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/apps-panel.html");
  const address = () =>
    page
      .getByRole("region", { name: "App 1 pane" })
      .getByRole("textbox", { name: "Address" });
  const current = "https://app1--bpsites.apps.builderlabstaging.xyz/second";
  await expect
    .poll(() => page.evaluate(() => window.appsPanelCalls.attached.length))
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => window.appsPanelCalls.attached[0]?.authenticated),
    )
    .toBe(true);
  await address().fill(current);
  await address().press("Enter");
  // This observed address comes from a completed native status poll.
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          window.appsPanelCalls.statuses.some(
            (entry) => entry.id === "guest-1" && entry.url === url,
          ),
        current,
      ),
    )
    .toBe(true);
  await expect(address()).toHaveValue(current);
  for (const index of [2, 3, 4, 5]) {
    await page
      .getByRole("button", { name: `Show app ${index}`, exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.appsPanelCalls.attached.length))
      .toBe(index);
  }
  await expect
    .poll(() => page.evaluate(() => window.appsPanelCalls.detached))
    .toContain("guest-1");
  await page.getByRole("button", { name: "Show app 1", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.appsPanelCalls.attached.at(-1)?.url))
    .toBe(current);
  await expect(address()).toHaveValue(current);
});
