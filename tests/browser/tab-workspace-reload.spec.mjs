import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// A real reload destroys module/React state while keeping this window's native
// history and session storage. Unit remounts cannot prove that boundary.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20 },
});

test("refresh restores profile and thread tabs, both panes and selection", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const main = page.locator("[data-main-workspace]");
  const side = page.locator("[data-panel-workspace]");
  const thread = (pane, index) =>
    pane.locator(
      `[role="tab"][data-tab-value="thread:alpha:${roots[index].id}"]`,
    );
  await main
    .getByRole("button", { name: "View Fixture Reader profile", exact: true })
    .first()
    .click();
  const profile = side.locator(
    '[role="tab"][data-tab-value^="buzz.profiles/profile:"]',
  );
  await expect(profile).toBeVisible();
  const openThread = async (index) => {
    await main
      .locator(
        `[data-channel-timeline="alpha"] [data-message-id="${roots[index].id}"]`,
      )
      .getByRole("button", { name: /^View thread:/ })
      .click();
  };
  await openThread(0);
  await thread(side, 0).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(thread(main, 0)).toBeFocused();
  await main.getByRole("tab", { name: "Alpha", exact: true }).click();
  await openThread(1);
  await expect(thread(side, 1)).toHaveAttribute("aria-selected", "true");
  const order = await side
    .locator('[role="tab"]')
    .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabValue));
  const visit = await page.evaluate(
    () => history.state.buzzNavigationV1.entry.id,
  );
  await page.screenshot({ path: testInfo.outputPath("before-refresh.png") });

  await page.reload();
  await expect(thread(side, 1)).toHaveAttribute("aria-selected", "true");
  await expect(profile).toBeVisible();
  await expect(thread(main, 0)).toBeVisible();
  await expect(
    main.getByRole("tab", { name: "Alpha", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      side
        .locator('[role="tab"]')
        .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabValue)),
    )
    .toEqual(order);
  expect(
    await page.evaluate(() => history.state.buzzNavigationV1.entry.id),
  ).toBe(visit);
  await expect(
    side.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("after-refresh.png") });

  // Back/Forward keeps workspace membership; explicit close stays closed on
  // another refresh. Main's existing dismissal semantics are unchanged here.
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(thread(main, 0)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Go forward", exact: true }).click();
  await expect(thread(side, 1)).toHaveAttribute("aria-selected", "true");
  await profile.click();
  await expect(
    side.getByRole("complementary", { name: "Profile", exact: true }),
  ).toBeVisible();
  await profile.click({ button: "middle" });
  await expect(profile).toHaveCount(0);
  await page.reload();
  await expect(thread(side, 1)).toBeVisible();
  await expect(profile).toHaveCount(0);
});
