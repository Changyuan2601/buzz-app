import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  threadPlacement: "inline",
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 40, beta: 1 },
});

const timeline = (page) => page.locator("[data-channel-timeline]");
const sheet = (page) =>
  page.getByRole("dialog", { name: "Thread", exact: true });
// The sheet's reader is a Thread region too; a tab is what placement adds.
const threadTab = (page) =>
  page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab");

// A reply sent to the channel sits below its thread. With Inline threads, its
// "Sent from" preview scrolls up to the thread's root and reads it there.
test("a sent-from-thread preview scrolls up to its root and opens it inline", async ({
  page,
  app,
}) => {
  await open(page, app);
  // Loaded, but well above the latest messages.
  const root = app.histories.get("primary/alpha")[25];
  for (let index = 0; index < 10; index++)
    app.append("primary", "alpha", `Later message ${index}`);
  const copy = app.append(
    "primary",
    "alpha",
    "A reply worth sharing",
    true,
    false,
    undefined,
    undefined,
    [["buzz:sent-from-thread", root.id, "Earlier root"]],
  );
  const rootRow = timeline(page).locator(`[data-message-id="${root.id}"]`);
  const copyRow = timeline(page).locator(`[data-message-id="${copy.id}"]`);
  await expect(copyRow).toBeInViewport();
  await expect(rootRow).not.toBeInViewport();
  await copyRow.getByRole("link", { name: "Thread — Earlier root" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(
    sheet(page).locator(`[data-message-id="${root.id}"]`),
  ).toBeVisible();
  await expect(threadTab(page)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
  // Closing it leaves the reader at the thread's root.
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(rootRow).toBeInViewport();
  await expect(rootRow).toBeFocused();
});

test("a channel's Activity preview opens its thread inline, and replaces an open one", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const [second, first] = ["Thread root 0", "Thread root 1"].map((content) =>
    history.find((row) => row.content === content),
  );
  // Read the first thread inline, then open the second from Activity.
  await timeline(page)
    .locator(`[data-message-id="${first.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  await expect(
    sheet(page).locator(`[data-message-id="${first.id}"]`),
  ).toBeVisible();
  await page.locator('button[data-channel-id="alpha"]').hover();
  await page
    .getByRole("dialog", { name: "Activity in Alpha" })
    .getByRole("button", { name: /Open unread thread from/ })
    .filter({ hasText: "Broadcast descendant" })
    .click();
  await expect(
    sheet(page).locator(`[data-message-id="${second.id}"]`),
  ).toBeVisible();
  await expect(
    sheet(page).locator(`[data-message-id="${first.id}"]`),
  ).toHaveCount(0);
  await expect(threadTab(page)).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
});

// The revealed root isn't tabbable, so closing must focus the row itself:
// its first tabbable is its author's avatar, whose focus opens a profile card.
test("closing a thread opened from a preview returns focus to its root's row", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const root = history.find((row) => row.content === "Thread root 0");
  await page.locator('button[data-channel-id="alpha"]').hover();
  await page
    .getByRole("dialog", { name: "Activity in Alpha" })
    .getByRole("button", { name: /Open unread thread from/ })
    .filter({ hasText: "Broadcast descendant" })
    .click();
  await expect(
    sheet(page).locator(`[data-message-id="${root.id}"]`),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  const row = timeline(page).locator(`[data-message-id="${root.id}"]`);
  await expect(
    row.getByRole("button", { name: "View Fixture Reader profile" }),
  ).toBeVisible();
  // Base UI's return focus lands a microtask after the sheet unmounts.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await expect(row).toBeFocused();
  await expect(page.locator(".buzz-preview-card-positioner")).toHaveCount(0);
});

test.describe("with threads in tabs", () => {
  test.use({ threadPlacement: "side" });

  test("a channel's Activity preview still opens a thread tab", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await page.locator('button[data-channel-id="alpha"]').hover();
    await page
      .getByRole("dialog", { name: "Activity in Alpha" })
      .getByRole("button", { name: /Open unread thread from/ })
      .filter({ hasText: "Broadcast descendant" })
      .click();
    await expect(threadTab(page)).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
  });
});
