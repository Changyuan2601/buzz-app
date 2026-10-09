import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { generateSecretKey } from "nostr-tools";

// Browser-only: actual Markdown link hit-testing, panel placement, two independent
// virtualized conversations and composer focus cannot be verified in jsdom.
test.use({
  pluginFixtures: true,
  sessionChannels: ["beta"],
  sessionWriteKinds: [9, 9000, 9007],
  historyCounts: { alpha: 2, beta: 2 },
});

// Base UI can retain a hidden, closed positioner after its popup exits.
// Wait for its visible paint and the dialog/chevron transitions to finish.
async function waitForSettledShareDialog(page) {
  await expect(page.locator(".buzz-select-positioner")).toBeHidden();
  await expect(page.locator(".buzz-select-popup")).toBeHidden();
  await expect(page.locator(".buzz-dialog[data-starting-style]")).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const popup = document.querySelector('.buzz-dialog[aria-modal="true"]');
        if (!popup) return -1;
        const backdrop = document.querySelector(".buzz-dialog-backdrop");
        return (
          popup.getAnimations({ subtree: true }).length +
          (backdrop?.getAnimations({ subtree: true }).length ?? 0)
        );
      }),
    )
    .toBe(0);
}

test("a session chip opens the same authorized conversation in the channel side pane", async ({
  page,
  app,
}) => {
  await open(page, app);
  const destination = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const link = app.append(
    "primary",
    "alpha",
    "[Session · beta](buzz://channel/beta)",
  );
  const row = destination.locator(`[data-message-id="${link.id}"]`);
  const chip = row.getByRole("link", { name: "Session · beta" });
  await expect(chip).toBeVisible();
  await expect(chip.locator("svg")).toBeVisible();
  await chip.click();
  const panel = page.locator("[data-panel-workspace]");
  await expect(panel.getByRole("tab", { name: "Beta" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const conversation = panel.getByRole("region", {
    name: "Conversation in Beta",
  });
  await expect(
    conversation.getByRole("region", { name: "Channel message history" }),
  ).toBeVisible();
  await expect(
    conversation.getByRole("textbox", { name: "Message this session" }),
  ).toBeVisible();
  await expect(
    destination.getByRole("textbox", { name: "Message #Alpha" }),
  ).toBeVisible();
  await expect(row).toBeVisible();
  const geometry = await conversation.evaluate((element) => {
    const column = element
      .querySelector("[data-session-column]")
      .getBoundingClientRect();
    const pane = element.getBoundingClientRect();
    const composer = element
      .querySelector('[aria-label="Message this session"]')
      .closest("form")
      .getBoundingClientRect();
    return {
      ratio: column.width / pane.width,
      inset: column.left - pane.left,
      composerRatio: composer.width / pane.width,
    };
  });
  expect(geometry.ratio).toBeGreaterThan(0.97);
  expect(geometry.inset).toBeLessThan(2);
  expect(geometry.composerRatio).toBeGreaterThan(0.83);
  await expect(
    page.getByRole("button", { name: "Previous sessions" }),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    for (const width of [1280, 950]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(
        conversation.getByRole("textbox", { name: "Message this session" }),
      ).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`session-pane-${mode}-${width}.png`),
      });
    }
  }
  await panel.getByRole("button", { name: "Close Beta tab" }).click();
  await expect(
    destination.getByRole("textbox", { name: "Message #Alpha" }),
  ).toBeVisible();
});

// Base UI Select/Radio portal styling and the compact footer require a real
// rendered app; jsdom covers behavior, not actual dialog appearance.
test("Share dialog uses styled controls in light/dark without extra status copy", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openSession(page, app, "beta");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share session" });
  await expect(
    dialog.getByRole("radio", { name: "Everyone in this channel" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(dialog.getByText("Choose selected people for now.")).toHaveCount(
    0,
  );
  await expect(dialog.getByText("Search to choose people.")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Share", exact: true }),
  ).toBeDisabled();
  const select = dialog.getByRole("combobox", { name: "Share to" });
  await select.click();
  await expect(page.getByRole("option", { name: "Alpha" })).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: test.info().outputPath(`session-share-menu-${mode}.png`),
    });
  }
  await page.getByRole("option", { name: "Alpha" }).click();
  await expect(select).toHaveAttribute("aria-expanded", "false");
  await waitForSettledShareDialog(page);
  await expect(
    dialog.getByRole("button", { name: "Share", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("searchbox", { name: "Find people" }),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    await waitForSettledShareDialog(page);
    await expect(
      dialog.getByRole("button", { name: "Share", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath(`session-share-ready-${mode}.png`),
    });
  }
  // Block only the foreground destination roster read. This proves the
  // fail-closed error state visually without publishing a fixture invitation.
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) =>
          filter.kinds?.includes(39002) && filter["#d"]?.includes("alpha"),
      )
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(1);
  await expect(
    dialog.getByRole("button", { name: "Retry share" }),
  ).toBeEnabled();
  await expect(dialog.getByText(/Retry to Alpha/)).toHaveCount(0);
  await waitForSettledShareDialog(page);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    await waitForSettledShareDialog(page);
    const retry = dialog.getByRole("button", { name: "Retry share" });
    await expect(retry).toBeEnabled();
    await expect(
      dialog.getByRole("button", { name: "Copy link" }),
    ).toBeEnabled();
    await expect(
      dialog.getByRole("radio", { name: "Everyone in this channel" }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath(`session-share-error-${mode}.png`),
    });
  }
});

// The modal's compact footprint, portal hit-testing, keyboard focus and
// viewport collision behavior need the actual app in both browser engines.
test("Selected people keeps the compact dialog and opens a human-only anchored list", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto(app.origin);
  await openSession(page, app, "beta");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share session" });
  await waitForSettledShareDialog(page);
  const rect = () =>
    dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const header = element.querySelector("header").getBoundingClientRect();
      const footer = element.querySelector("footer").getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        header: header.y,
        footer: footer.y,
      };
    });
  const initial = await rect();
  await dialog.getByRole("radio", { name: "Selected people" }).click();
  const search = dialog.getByRole("combobox", { name: "Find people" });
  await expect(search).toBeVisible();
  expect(await rect()).toEqual(initial);
  await expect(dialog.getByText("Search to choose people.")).toHaveCount(0);
  // SearchField is the Add-tab component. Compare its paint against the
  // destination control and the elevated dialog before focus changes it.
  const colors = await search.evaluate((input) => {
    const dialog = input.closest("[role=dialog]");
    const frame = input.closest(".buzz-input-group");
    const select = dialog.querySelector(".buzz-select-trigger");
    return {
      search: getComputedStyle(frame).backgroundColor,
      select: getComputedStyle(select).backgroundColor,
      panel: getComputedStyle(dialog).backgroundColor,
    };
  });
  expect(colors.search).toBe("rgb(245, 245, 246)");
  expect(colors.select).toBe(colors.search);
  expect(colors.panel).toBe("rgb(255, 255, 255)");
  await page.screenshot({
    path: test.info().outputPath("session-share-selected-rest-light.png"),
  });
  await page.setViewportSize({ width: 1280, height: 850 });
  await waitForSettledShareDialog(page);
  await page.screenshot({
    path: test
      .info()
      .outputPath("session-share-selected-rest-desktop-light.png"),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await waitForSettledShareDialog(page);
  const darkColors = await search.evaluate((input) => {
    const dialog = input.closest('[role="dialog"]');
    return {
      search: getComputedStyle(input.closest(".buzz-input-group"))
        .backgroundColor,
      select: getComputedStyle(dialog.querySelector(".buzz-select-trigger"))
        .backgroundColor,
      panel: getComputedStyle(dialog).backgroundColor,
      token: getComputedStyle(dialog)
        .getPropertyValue("--surface-popover")
        .trim(),
    };
  });
  expect(darkColors.search).not.toBe(darkColors.panel);
  expect(darkColors.select).toBe(darkColors.search);
  expect(darkColors.panel).toBe("rgb(40, 40, 40)");
  expect(darkColors.token).toBe("#282828");
  await page.screenshot({
    path: test
      .info()
      .outputPath("session-share-selected-rest-desktop-dark.png"),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
  });
  await page.setViewportSize({ width: 390, height: 620 });
  await expect.poll(rect).toEqual(initial);
  let signal;
  const requested = new Promise((resolve) => {
    signal = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const humans = Array.from({ length: 12 }, (_, index) =>
    app.serveProfile(generateSecretKey(), {
      name: `Morgan person ${index + 1}`,
    }),
  );
  const bot = app.serveProfile(generateSecretKey(), {
    name: "Morgan agent",
    is_agent: true,
  });
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) => filter.kinds?.includes(0) && filter.search === "Morgan",
      )
    ) {
      signal();
      await held;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([...humans, bot]),
      });
    } else await route.continue();
  });
  try {
    await search.fill("Morgan");
    await requested;
    const list = dialog.getByRole("listbox", { name: "People" });
    await expect(list.getByRole("status")).toHaveText("Searching…");
    expect(await rect()).toEqual(initial);
    release();
    await expect(list.getByRole("option")).toHaveCount(12);
    await expect(list.getByText("Morgan agent")).toHaveCount(0);
    expect(await rect()).toEqual(initial);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const popup = document.querySelector(".buzz-popover-popup");
          return popup?.getAnimations({ subtree: true }).length ?? -1;
        }),
      )
      .toBe(0);
    const resultPaint = await page
      .locator(".buzz-popover-popup")
      .evaluate((el) => ({
        fill: getComputedStyle(el).backgroundColor,
        opacity: getComputedStyle(el).opacity,
        blur: getComputedStyle(el).backdropFilter,
        parent: el.closest('[role="dialog"]')?.getAttribute("role"),
      }));
    expect(resultPaint).toMatchObject({
      fill: "rgb(255, 255, 255)",
      opacity: "1",
      blur: "none",
    });
    expect(resultPaint.parent).toBe("dialog");
    await page.screenshot({
      path: test.info().outputPath("session-share-results-light.png"),
    });
    await page.setViewportSize({ width: 1280, height: 850 });
    await expect(list.getByRole("option")).toHaveCount(12);
    await expect
      .poll(() => page.locator(".buzz-popover-popup").getAttribute("data-side"))
      .toBe("bottom");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector(".buzz-popover-popup")
              ?.getAnimations({ subtree: true }).length ?? -1,
        ),
      )
      .toBe(0);
    await page.screenshot({
      path: test.info().outputPath("session-share-results-desktop-light.png"),
    });
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await expect(page.locator(".buzz-popover-popup")).toHaveCSS("opacity", "1");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const popup = document.querySelector(".buzz-popover-popup");
          return popup?.getAnimations({ subtree: true }).length ?? -1;
        }),
      )
      .toBe(0);
    const darkPopup = await page
      .locator(".buzz-popover-popup")
      .evaluate((el) => ({
        fill: getComputedStyle(el).backgroundColor,
        token: getComputedStyle(el)
          .getPropertyValue("--surface-popover")
          .trim(),
        blur: getComputedStyle(el).backdropFilter,
      }));
    expect(darkPopup.fill).toBe("rgb(40, 40, 40)");
    expect(darkPopup.token).toBe("#282828");
    expect(darkPopup.blur).toBe("none");
    await page.screenshot({
      path: test.info().outputPath("session-share-results-desktop-dark.png"),
    });
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "light";
    });
    await page.setViewportSize({ width: 390, height: 620 });
    await expect.poll(rect).toEqual(initial);
    await search.press("ArrowDown");
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
    await search.press("ArrowUp");
    await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
    const popupGeometry = await page
      .locator(".buzz-popover-popup")
      .evaluate((el) => ({
        height: el.clientHeight,
        content: el.scrollHeight,
        css: getComputedStyle(el).overflowY,
      }));
    expect(popupGeometry).toMatchObject({ css: "auto" });
    expect(popupGeometry.content).toBeGreaterThan(popupGeometry.height);
    await list
      .getByRole("option", { name: /Morgan person 9\b/ })
      .scrollIntoViewIfNeeded();
    await expect(
      list.getByRole("option", { name: /Morgan person 9\b/ }),
    ).toBeInViewport();
    await search.press("Escape");
    await expect(list).toBeHidden();
    await expect(dialog).toBeVisible();
    await search.press("ArrowDown");
    await expect(list).toBeVisible();
    await search.press("Enter");
    await expect(
      dialog.getByRole("button", { name: "1 selected" }),
    ).toBeVisible();
    expect(await rect()).toEqual(initial);
    await dialog.getByRole("button", { name: "1 selected" }).click();
    await expect(
      list.getByRole("button", { name: /Remove Morgan person/ }),
    ).toBeVisible();
    await list.getByRole("button", { name: /Remove Morgan person/ }).click();
    await expect(
      dialog.getByRole("button", { name: "1 selected" }),
    ).toHaveCount(0);
    expect(await rect()).toEqual(initial);
    await search.fill("No matching identity");
    await expect(list.getByText("No people found.")).toBeVisible();
    expect(await rect()).toEqual(initial);
    await search.fill("");
    await expect(list).toBeHidden();
    expect(await rect()).toEqual(initial);
    await page.setViewportSize({ width: 320, height: 500 });
    await expect
      .poll(async () => {
        const box = await rect();
        return (
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= 320 &&
          box.y + box.height <= 500
        );
      })
      .toBe(true);
    await expect(
      dialog.getByRole("button", { name: "Copy link" }),
    ).toBeInViewport();
    await search.fill("Morgan");
    await expect(list.getByRole("option")).toHaveCount(12);
    await expect(list).toBeInViewport();
    const popupBounds = await page.locator(".buzz-popover-popup").boundingBox();
    expect(popupBounds.x).toBeGreaterThanOrEqual(0);
    expect(popupBounds.y).toBeGreaterThanOrEqual(0);
    expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(320);
    expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(500);
    // A click on the overlapping result area must not land on Share underneath.
    const share = dialog.getByRole("button", { name: "Share", exact: true });
    await expect(share).toBeDisabled();
    await list.getByRole("option", { name: /Morgan person 2\b/ }).click();
    await expect(
      dialog.getByRole("button", { name: "1 selected" }),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await search.fill("Morgan");
    await expect(list.getByRole("option")).toHaveCount(11);
    await search.press("Escape");
    await expect(list).toBeHidden();
    await search.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    release();
  }
});

async function openSession(page, app, channelId, messageId) {
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(
    await page.evaluate((target) => window.fixtureNavigation.open(target), {
      version: 1,
      kind: "conversation",
      channelId,
      ...(messageId ? { messageId } : {}),
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
    }),
  ).toEqual({ status: "opened" });
}

test.describe("Messages Share navigation", () => {
  test.use({
    sessionChannels: ["alpha", "beta"],
    channelIds: ["alpha", "beta", "gamma"],
    channelNames: { gamma: "Gamma" },
    historyCounts: { alpha: 1, beta: 1, gamma: 0 },
  });

  // Browser-only: production ChannelsPage reconciliation and host/browser history
  // must tear down a portalled Share dialog before another source becomes active.
  test("Messages Share choices never cross source or history visits", async ({
    page,
    app,
  }) => {
    const aria = app.serveProfile(generateSecretKey(), { name: "Aria" });
    await page.route("**/api/relay/**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (
        filters.some(
          (filter) => filter.kinds?.includes(0) && filter.search === "Aria",
        )
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([aria]),
        });
      } else await route.continue();
    });
    await page.goto(app.origin);
    await openSession(page, app, "alpha");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share session" });
    await dialog.getByRole("combobox", { name: "Share to" }).click();
    await page.getByRole("option", { name: "Gamma", exact: true }).click();
    await dialog.getByRole("radio", { name: "Selected people" }).click();
    await dialog.getByRole("combobox", { name: "Find people" }).fill("Aria");
    await dialog.getByRole("option", { name: /Aria/ }).click();
    await expect(
      dialog.getByRole("button", { name: "1 selected" }),
    ).toBeVisible();
    await openSession(page, app, "beta");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Share to" })).toHaveText(
      "Choose a channel",
    );
    await expect(
      dialog.getByRole("radio", { name: "Everyone in this channel" }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("button", { name: "Share", exact: true }),
    ).toBeDisabled();
    await page.goBack();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          channel: window.fixtureNavigation.snapshot().entry.target.channelId,
          status: window.fixtureNavigation.snapshot().status,
        })),
      )
      .toEqual({ channel: "alpha", status: "opened" });
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Share to" })).toHaveText(
      "Choose a channel",
    );
    await expect(
      dialog.getByRole("button", { name: "Share", exact: true }),
    ).toBeDisabled();
    // Another message visit in the same source also discards unsent UI.
    await dialog.getByRole("combobox", { name: "Share to" }).click();
    await page.getByRole("option", { name: "Gamma", exact: true }).click();
    const next = app.append(
      "primary",
      "alpha",
      "A new visit in the same session",
    );
    await openSession(page, app, "alpha", next.id);
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Share to" })).toHaveText(
      "Choose a channel",
    );
  });
});
