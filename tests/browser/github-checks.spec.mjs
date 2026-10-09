import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
// Real browser wiring: shared keyboard tabs, retained rendered description and
// outcome disclosures, hover/focus menus and narrow reflow, plugin navigation/reset.
// Clipboard results and source/URL matrices stay in Vitest.
test("standalone PR checks load on activation, retain disclosures, and reset without changing other objects", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.copiedCheckLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (url) => window.copiedCheckLinks.push(url) },
    });
  });
  const requests = [];
  const targets = [
    "https://github.com/sample/project/pull/1",
    "https://github.com/sample/project/pull/2",
    "https://github.com/sample/project/issues/3",
  ];
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path.endsWith("/comments") || path.endsWith("/reviews"))
        return route.fulfill({ json: [] });
      return route.fulfill({
        json: path.endsWith("/check-runs")
          ? {
              total_count: 1,
              check_runs: [
                {
                  name: path.includes("head-sha-long")
                    ? `Unit tests / ${"long-check-name-".repeat(12)}`
                    : "Unit tests",
                  status: "completed",
                  conclusion: "success",
                  details_url:
                    "https://github.com/sample/project/actions/runs/1",
                  output: { title: "All tests passed" },
                },
              ],
            }
          : path.endsWith("/status")
            ? {
                total_count: 1,
                statuses: [
                  {
                    context: "Build",
                    state: "failure",
                    description: "Compilation failed",
                  },
                ],
              }
            : {
                title: path.endsWith("/1")
                  ? "First PR"
                  : path.endsWith("/2")
                    ? "Second PR"
                    : "Existing issue",
                body: "Main description\n\n## Details",
                body_html: "<p>Main description</p><h2>Details</h2>",
                head: {
                  sha: path.endsWith("/2") ? "head-sha-long" : "head-sha",
                },
                comments: 2,
              },
      });
    },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", targets.join(" "));
  const link = (url) => page.locator(`[data-message-id] a[href="${url}"]`);
  await expect(link(targets[0])).toBeAttached();
  await end(page);
  await link(targets[0]).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const discussion = panel.getByRole("tab", {
    name: "Discussion",
    exact: true,
  });
  const checksTab = panel.getByRole("tab", { name: "Checks", exact: true });
  const description = panel.getByRole("tabpanel", {
    name: "Discussion",
    exact: true,
  });
  await description
    .getByRole("button", { name: "Expand Description", exact: true })
    .click();
  await expect(
    description.getByRole("heading", { name: "Details" }),
  ).toBeVisible();
  await expect(
    description.getByRole("region", { name: "Pull request conversation" }),
  ).toBeVisible();
  await expect(
    description.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await expect(discussion).toHaveAttribute("aria-selected", "true");
  await settle(page); // description/details mount is the completed loading boundary
  expect([...requests].sort()).toEqual([
    "/repos/sample/project/issues/1/comments",
    "/repos/sample/project/pulls/1",
    "/repos/sample/project/pulls/1/reviews",
  ]);
  const details = await description
    .getByRole("heading", { name: "Details" })
    .elementHandle();
  await discussion.focus();
  await page.keyboard.press("ArrowRight");
  await expect(checksTab).toBeFocused();
  await expect(checksTab).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(checksTab).toHaveAttribute("aria-selected", "true");
  const checks = panel.getByRole("tabpanel", { name: "Checks", exact: true });
  await expect(checks).toContainText("Some checks were not successful");
  await expect(checks.getByRole("listitem")).toHaveCount(2);
  const spacing = await panel.locator('[class*="pullTabs"]').evaluate((n) => {
    const list = n.querySelector('[role="tablist"]');
    const box = list.getBoundingClientRect();
    // The shared tab list reserves its keyboard focus ring inside its own box
    // and cancels that reservation with a negative block margin, so the border
    // box now bleeds 4px into this gap while nothing visible moves. Measure the
    // content edge, which is where the tabs are actually drawn.
    const style = getComputedStyle(list);
    const tabs = {
      top: box.top + Number.parseFloat(style.paddingTop),
      bottom: box.bottom - Number.parseFloat(style.paddingBottom),
    };
    const previous = n.previousElementSibling.getBoundingClientRect();
    const card = n.parentElement
      .querySelector('[class*="checksCard"]')
      .getBoundingClientRect();
    return {
      before: tabs.top - previous.bottom,
      after: card.top - tabs.bottom,
    };
  });
  expect(spacing.before).toBe(20);
  expect(spacing.after).toBe(20);
  const row = checks.getByRole("listitem").filter({ hasText: "Unit tests" });
  const actions = row.getByRole("button", { name: "Actions for Unit tests" });
  const actionSlot = actions.locator("..");
  const rowLink = row.getByRole("link", { name: "Unit tests", exact: true });
  await page.mouse.move(0, 0);
  await expect(actionSlot).toHaveCSS("opacity", "0");
  const before = await rowLink.boundingBox();
  await row.hover();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  expect(await rowLink.boundingBox()).toEqual(before);
  await actions.click();
  const item = page.getByRole("menuitem", { name: "Copy link", exact: true });
  await expect(item).toBeVisible();
  await expect(page.getByRole("menu")).toHaveAttribute("data-size", "default");
  await page.mouse.move(0, 0);
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(actions).toBeFocused();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Link copied", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.copiedCheckLinks)).toEqual([
    "https://github.com/sample/project/actions/runs/1",
  ]);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(
    checks.getByRole("button", { name: "1 successful check", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    checks.getByRole("button", { name: "Actions for Build" }),
  ).toHaveCount(0);

  // A long unbroken name plus 200% interface text must leave the menu reachable.
  // Change the fixture response on the next PR rather than mutating rendered content.
  const successful = checks.getByRole("button", {
    name: "1 successful check",
    exact: true,
  });
  await successful.click();
  await expect(successful).toHaveAttribute("aria-expanded", "false");
  await checksTab.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(description).toBeVisible();
  expect(await details.evaluate((node) => node.isConnected)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(successful).toHaveAttribute("aria-expanded", "false");
  await settle(page);
  expect(requests).toHaveLength(5);
  await successful.click();
  await expect(
    checks.getByRole("link", { name: "Unit tests" }),
  ).toHaveAttribute("href", "https://github.com/sample/project/actions/runs/1");
  await link(targets[1]).click();
  await expect(
    panel.getByRole("heading", { name: "Second PR #2", exact: true }),
  ).toBeVisible();
  await expect(discussion).toHaveAttribute("aria-selected", "true");
  await settle(page);
  expect(requests).toHaveLength(8);
  await checksTab.click();
  await expect(checks.getByRole("listitem")).toHaveCount(2);
  await expect(successful).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await page.setViewportSize({ width: 480, height: 950 });
  const longRow = checks
    .getByRole("listitem")
    .filter({ hasText: "long-check-name-" });
  const longAction = longRow.getByRole("button", {
    name: /^Actions for Unit tests/,
  });
  await longAction.scrollIntoViewIfNeeded();
  await longAction.focus();
  await expect(longAction.locator("..")).toHaveCSS("opacity", "1");
  const bounds = await longRow.boundingBox();
  const buttonBounds = await longAction.boundingBox();
  expect(buttonBounds.x).toBeGreaterThanOrEqual(bounds.x);
  expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(
    bounds.x + bounds.width + 1,
  );
  expect(
    await longRow.evaluate((n) => n.scrollWidth - n.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.keyboard.press("Enter");
  await expect(item).toBeVisible();
  const menuBounds = await page.getByRole("menu").boundingBox();
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(480);
  await page.keyboard.press("Escape");
  await expect(longAction).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "1");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await link(targets[2]).click();
  await expect(
    panel.getByRole("heading", { name: "Existing issue", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Details" })).toBeVisible();
  await settle(page);
  expect(requests).toHaveLength(11);
  await expect(panel.getByRole("tablist")).toHaveCount(0);
  await expect(panel.getByText("Comments", { exact: true })).toBeVisible();
});

// Browser-only contract: native focus stays on the same shared loading button,
// then transfers to the summary only if that button still owns focus.
test("keyboard Retry recovers mixed checks without losing or stealing focus", async ({
  page,
  app,
}) => {
  let phase = "mixed-pending";
  let deferred = false;
  let release;
  let gate;
  const requests = [];
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      if (
        url.pathname.endsWith("/comments") ||
        url.pathname.endsWith("/reviews")
      )
        return route.fulfill({ json: [] });
      if (url.pathname.includes("/pulls/"))
        return route.fulfill({
          json: { title: "Recovery PR", head: { sha: "same-sha" } },
        });
      if (deferred) await gate;
      // A malformed source response exercises the loader's real failure path
      // without adding an HTTP-console exception to the shared fixture.
      if (phase === "unavailable") return route.fulfill({ json: {} });
      return route.fulfill({
        json: url.pathname.endsWith("/check-runs")
          ? {
              total_count: 1,
              check_runs: [
                {
                  name: "Review gate",
                  status: "completed",
                  conclusion: phase === "success" ? "success" : null,
                },
              ],
            }
          : {
              total_count: 1,
              statuses: [
                {
                  context: "Build",
                  state: phase === "mixed-pending" ? "pending" : "failure",
                },
              ],
            },
      });
    },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append(
    "primary",
    "alpha",
    "https://github.com/sample/project/pull/1 https://github.com/sample/project/pull/2",
  );
  const link = (id) =>
    page.locator(
      `[data-message-id] a[href="https://github.com/sample/project/pull/${id}"]`,
    );
  await expect(link(1)).toBeAttached();
  await end(page);
  await link(1).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const checksTab = panel.getByRole("tab", { name: "Checks", exact: true });
  const discussion = panel.getByRole("tab", {
    name: "Discussion",
    exact: true,
  });
  await checksTab.click();
  const checks = panel.getByRole("tabpanel", { name: "Checks", exact: true });
  const summary = checks.locator("[data-check-state]");
  const retry = checks.getByRole("button", {
    name: "Retry checks",
    exact: true,
  });
  await expect(summary).toHaveAttribute("data-check-state", "pending");
  await expect(checks.getByRole("listitem")).toHaveCount(2);
  expect(requests).toHaveLength(5);

  // Failed retry keeps the action and its focus; successful retries remove it.
  // Moving away during a request must win over any completion handoff.
  for (const [outcome, moved] of [
    ["unavailable", false],
    ["success", true],
    ["success", false],
  ]) {
    if (outcome === "success" && !moved) {
      phase = "mixed-failure";
      await link(2).click();
      await expect(discussion).toHaveAttribute("aria-selected", "true");
      await checksTab.click();
      await expect(summary).toHaveAttribute("data-check-state", "failure");
      await expect(retry).toBeVisible();
    }
    await retry.focus();
    const sameButton = await retry.elementHandle();
    const before = requests.length;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    deferred = true;
    phase = outcome;
    try {
      await page.keyboard.press("Enter");
      await expect.poll(() => requests.length).toBe(before + 2);
      await expect(summary).toContainText("Loading…");
      await expect(retry).toHaveAttribute("aria-busy", "true");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await expect(retry).toBeFocused();
      expect(
        await sameButton.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Enter");
      if (moved) {
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(checks).toBeFocused();
      }
    } finally {
      release();
      deferred = false;
    }
    await expect(summary).toContainText(
      outcome === "unavailable"
        ? "Unavailable"
        : "Some checks were not successful",
    );
    expect(requests).toHaveLength(before + 2);
    if (outcome === "unavailable") {
      await expect(retry).toBeFocused();
      await expect(retry).not.toHaveAttribute("aria-busy", "true");
      expect(
        await sameButton.evaluate((node) => node === document.activeElement),
      ).toBe(true);
    } else {
      await expect(retry).toHaveCount(0);
      await expect(checks.getByRole("listitem")).toHaveCount(2);
      await expect(checks.getByText("Unknown", { exact: true })).toHaveCount(0);
      await expect(summary).toHaveAttribute("data-check-state", "failure");
      if (moved) await expect(checks).toBeFocused();
      else await expect(summary).toBeFocused();
    }
  }
  expect(requests.filter((path) => /\/pulls\/\d+$/.test(path))).toHaveLength(2);
  expect(
    requests
      .filter((path) => path.includes("/commits/"))
      .every((path) => path.includes("/same-sha/")),
  ).toBe(true);
});
