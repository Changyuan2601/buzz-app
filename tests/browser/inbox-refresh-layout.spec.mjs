import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real layout and header truncation cannot be inferred from jsdom. Hold the
// addressed refresh while ordinary unread catch-up completes so only the loading
// indicator (not the separate stale/error notices) can change row geometry.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const width of [1280, 390, 320]) {
  test(`Inbox refresh status preserves layout at ${width}px`, async ({
    page,
    app,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const status = inbox.getByText("Checking recent activity…", {
      exact: true,
    });
    const list = inbox.getByRole("list", { name: "Inbox conversations" });
    const rows = list.getByRole("listitem");
    const filters = inbox.getByRole("button", {
      name: /^Inbox filters:/,
      exact: true,
    });
    await expect(rows).toHaveCount(3);
    await expect(status).toHaveCount(0);
    let gate;
    await page.route("**/api/relay/primary/query", async (route) => {
      const pending = gate;
      if (
        !pending ||
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter["#p"] && filter.kinds?.includes(9))
      )
        return route.continue();
      pending.started = true;
      await pending.promise;
      await route.continue();
    });
    const geometry = () =>
      inbox.evaluate((element) => {
        const box = (node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          rows: [
            ...element.querySelectorAll(
              '[aria-label="Inbox conversations"] > li',
            ),
          ].map((row) => ({ ...box(row), text: row.textContent })),
          header: box(element.querySelector("header")),
          filters: box(element.querySelector('[aria-label^="Inbox filters:"]')),
          unread: box(element.querySelector('[aria-label="Unread only"]')),
        };
      });
    const measurements = [];
    await expect(filters).toBeVisible();
    const before = await geometry();
    gate = { ...Promise.withResolvers(), started: false };
    try {
      app.relay.disconnect("primary");
      await expect.poll(() => gate.started).toBe(true);
      await expect(status).toBeVisible();
      await expect(inbox.getByText("Showing retained activity.")).toHaveCount(
        0,
      );
      await expect.poll(geometry).toEqual(before);
      expect(
        await status.evaluate((element) => element.closest("header") !== null),
      ).toBe(true);
      const textStyle = await status.evaluate((element) => ({
        whiteSpace: getComputedStyle(element).whiteSpace,
        overflow: getComputedStyle(element).overflow,
        textOverflow: getComputedStyle(element).textOverflow,
        width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
      }));
      expect(textStyle).toMatchObject({
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      if (width === 320)
        expect(textStyle.scrollWidth).toBeGreaterThan(textStyle.width);
      const during = await geometry();
      measurements.push({ width, before, during, textStyle });
    } finally {
      gate.resolve();
      gate = undefined;
    }
    await expect(status).toHaveCount(0);
    await expect.poll(geometry).toEqual(before);
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    await expect(filters).toHaveAccessibleDescription(/Activity: All\./);
    await inbox.getByRole("button", { name: /^Filter by sender/ }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "Everyone", exact: true }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await testInfo.attach("refresh-geometry", {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
  });
}

// Only a browser can prove that the sibling Archive control leaves readable
// label space when the host's interface size doubles at a narrow width.
test("narrow enlarged-text rows reflow Archive without erasing their labels", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await expect(list).toHaveAttribute("aria-busy", "false");
  const row = rows.first();
  const open = row.getByRole("button", { name: /^Open / });
  const archive = row.getByRole("button", { name: /^Archive / });
  const geometry = () =>
    row.evaluate((element) => {
      const open = element.querySelector(".navigation-item");
      const label = open.querySelector(".navigation-item-label");
      const action = element.querySelector('[class*="rowActions"]');
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        row: box(element),
        open: box(open),
        label: box(label),
        sender: box(element.querySelector("strong")),
        action: box(action),
      };
    });
  const measured = await geometry();
  // NavigationItem truncates long labels at enlarged text sizes; this checks
  // that Archive reserves no additional inline space, not full visual acceptance.
  expect(measured.label.width).toBeGreaterThanOrEqual(2 * measured.root);
  expect(measured.sender.width).toBeGreaterThanOrEqual(measured.root);
  expect(measured.open.x + measured.open.width).toBe(
    measured.row.x + measured.row.width,
  );
  expect(measured.action.x + measured.action.width).toBeLessThanOrEqual(
    measured.open.x + measured.open.width,
  );
  expect(measured.action.y).toBeGreaterThanOrEqual(measured.open.y);
  await open.focus();
  await expect(archive).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("inbox-enlarged-text.png"),
  });
  await archive.click();
  await expect(rows).toHaveCount(2);
  await inbox.getByRole("tab", { name: "Archived", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(
    inbox.getByRole("tab", { name: "Archived", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await rows.getByRole("button", { name: /^Open / }).focus();
  await rows.getByRole("button", { name: /^Restore / }).click();
  await expect(rows).toHaveCount(0);
  await expect(inbox.getByRole("region", { name: "Inbox detail" })).toHaveCount(
    0,
  );
  await inbox.getByRole("tab", { name: "Inbox", exact: true }).click();
  const filters = inbox.getByRole("button", {
    name: /^Inbox filters:/,
    exact: true,
  });
  await filters.click();
  await page
    .getByRole("menuitemradio", { name: "Mentions", exact: true })
    .click();
  await inbox.getByRole("button", { name: /^Filter by sender/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Agents", exact: true })
    .click();
  await expect(filters).toHaveAccessibleDescription("Activity: Mentions.");
  await expect
    .poll(() =>
      filters.evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(390);
});

// Native focus loss when React replaces a focused trigger requires a browser.
test("compact filter transitions preserve focus ownership", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  for (const name of [/^Inbox filters:/, /^Filter by sender:/]) {
    const trigger = inbox.getByRole("button", { name });
    await trigger.focus();
    for (const width of [850, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      if (width === 850)
        await expect(trigger).toHaveAttribute("data-icon-size", "sm");
      else await expect(trigger).not.toHaveAttribute("data-icon-size");
      await expect(trigger).toBeFocused();
    }
  }
  const tab = inbox.getByRole("tab", { name: "Inbox", exact: true });
  await tab.focus();
  await page.setViewportSize({ width: 850, height: 800 });
  await expect(
    inbox.getByRole("button", { name: /^Inbox filters:/ }),
  ).toHaveAttribute("data-icon-size", "sm");
  await expect(tab).toBeFocused();
});
