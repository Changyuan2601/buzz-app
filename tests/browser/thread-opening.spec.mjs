import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

// Real scroll geometry and the first painted frame cannot be proven in jsdom.
test.use({
  pluginFixtures: true,
  exactMessages: true,
  historyCounts: { alpha: 103, beta: 1 },
});
test("ordinary thread reveals its first content already positioned at the bottom", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.messageArrivals = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const row = this.closest("[data-message-id]");
      const reader = this.closest("[data-message-scroller]");
      if (row && reader) {
        const bounds = row.getBoundingClientRect();
        const viewport = reader.getBoundingClientRect();
        window.messageArrivals.push({
          id: row.dataset.messageId,
          reader: reader.hasAttribute("data-channel-timeline")
            ? "channel"
            : reader.getAttribute("aria-label"),
          visible: bounds.bottom > viewport.top && bounds.top < viewport.bottom,
          positioned: !reader.hasAttribute("data-positioning"),
        });
      }
      return animate.apply(this, args);
    };
  });
  await open(page, app);
  // The initial navigation is keyboard-driven; pointer navigation opts into motion.
  await page.locator('button[data-channel-id="beta"]').click();
  await settle(page);
  const channelArrivals = await page.evaluate(() =>
    window.messageArrivals.filter((arrival) => arrival.reader === "channel"),
  );
  expect(channelArrivals.length).toBeGreaterThan(0);
  let release, intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    )
      return route.continue();
    intercepted();
    await held;
    await route.continue().catch(() => {});
  });
  const history = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  try {
    await page.evaluate(
      (value) => {
        void window.fixtureNavigation.open(value);
      },
      {
        version: 1,
        kind: "conversation",
        channelId: "alpha",
        messageId: app.exact.root.id,
        threadRootId: app.exact.root.id,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      },
    );
    await seen;
    await expect(
      page.locator(
        '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
      ),
    ).toBeFocused();
    await expect(history).toHaveAttribute("data-positioning");
    await expect(history.getByRole("status")).toHaveText("Loading thread…");
    await expect(history.getByRole("status")).toBeInViewport();
    await expect(history.locator("[data-thread-rows]")).toHaveAttribute(
      "inert",
    );
    await expect(history.locator("[data-thread-rows]")).toHaveCSS(
      "opacity",
      "0",
    );
    await page.evaluate(() => {
      const sample = () => {
        const el = document.querySelector('[aria-label="Thread messages"]');
        if (el && !el.hasAttribute("data-positioning")) {
          window.firstThreadFrame = {
            top: el.scrollTop,
            gap: el.scrollHeight - el.clientHeight - el.scrollTop,
          };
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  } finally {
    release();
  }
  await expect(history).not.toHaveAttribute("data-positioning");
  await expect(history.locator("[data-thread-rows]")).not.toHaveAttribute(
    "inert",
  );
  await expect(history.locator("[data-message-id]")).toHaveCount(81);
  await expect
    .poll(() => page.evaluate(() => window.firstThreadFrame))
    .toBeTruthy();
  const first = await page.evaluate(() => window.firstThreadFrame);
  expect(first.top).toBeGreaterThan(0);
  expect(Math.abs(first.gap)).toBeLessThanOrEqual(1);
  const arrivals = await page.evaluate(() =>
    window.messageArrivals.filter(
      (arrival) => arrival.reader === "Thread messages",
    ),
  );
  expect(arrivals.length).toBeGreaterThan(0);
  expect(
    arrivals.every((arrival) => arrival.visible && arrival.positioned),
  ).toBe(true);
});
