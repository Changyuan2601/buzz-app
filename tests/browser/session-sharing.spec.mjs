import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { generateSecretKey } from "nostr-tools";
import { formatPublicKey } from "../../src/shared/identity/public-key.ts";

// Browser-only: actual Markdown link hit-testing, panel placement, two independent
// virtualized conversations and composer focus cannot be verified in jsdom.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  dmLabels: true,
  agentPeers: true,
  sessionChannels: ["beta"],
  sessionWriteKinds: [9, 9000, 9007],
  historyCounts: { alpha: 2, beta: 2 },
});

test("a session chip opens the same authorized conversation in the channel side pane", async ({
  page,
  app,
}) => {
  const title = "Make contrast meet accessibility standards ".repeat(2).trim();
  await page.route("**/query", async (route) => {
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      response,
      json: events.map((event) => {
        if (
          event.kind !== 39000 ||
          !event.tags.some(([key, value]) => key === "d" && value === "beta")
        )
          return event;
        return app.signRelay({
          kind: event.kind,
          created_at: event.created_at,
          content: event.content,
          tags: [
            ...event.tags.map((tag) =>
              tag[0] === "name"
                ? ["name", title]
                : tag[0] === "about"
                  ? ["about", "Buzz session (buzz.sessions/v1)"]
                  : tag,
            ),
            ["t", "buzz.session.named"],
          ],
        });
      }),
    });
  });
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
  const chip = row.getByRole("link", {
    name: `Open Session: ${title}`,
    exact: true,
  });
  await expect(chip).toBeVisible();
  await expect(chip.locator("svg.tabler-icon-file-text")).toBeVisible();
  await chip.click();
  const panel = page.locator("[data-panel-workspace]");
  await expect(panel.getByRole("tab", { name: title })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const conversation = panel.getByRole("region", {
    name: `Conversation in ${title}`,
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
  await panel.getByRole("button", { name: `Close ${title} tab` }).click();
  await page.setViewportSize({ width: 390, height: 850 });
  await expect(chip).toBeVisible();
  const linkBounds = await chip.evaluate((el) => ({
    right: el.getBoundingClientRect().right,
    viewport: innerWidth,
  }));
  expect(linkBounds.right).toBeLessThanOrEqual(linkBounds.viewport);
  await page.screenshot({
    path: test.info().outputPath("named-session-link-390.png"),
  });
  await expect(
    destination.getByRole("textbox", { name: "Message #Alpha" }),
  ).toBeVisible();
});

// Real modal/footer reachability, portal hit-testing and focus in both engines.
async function reachable(locator, { scroll = true } = {}) {
  if (scroll) await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
    )
    .toBe(true);
}

test("Share dialog keeps actions reachable across themes, viewports and enlarged text and recovers an exact link", async ({
  page,
  app,
}) => {
  // Pre-existing grants have no device-local provenance. Keep the large fallback
  // collapsed, and prove real scrolling cannot push the fixed footer away.
  const legacyPeople = Array.from({ length: 14 }, (_, index) =>
    app.serveProfile(generateSecretKey(), {
      name: `Existing person ${index + 1}`,
    }),
  );
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters.some((filter) => filter.kinds?.includes(39002)))
      return route.continue();
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      json: events.map((event) => {
        if (
          event.kind !== 39002 ||
          !event.tags.some(([key, value]) => key === "d" && value === "beta")
        )
          return event;
        return app.signRelay({
          ...event,
          tags: [
            ...event.tags,
            ...legacyPeople.map((person) => ["p", person.pubkey, "", "member"]),
          ],
        });
      }),
    });
  });
  await page.goto(app.origin);
  await openSession(page, app, "beta");
  const trigger = page.getByRole("button", { name: "Share", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Share session" });
  const search = dialog.getByRole("combobox", { name: "People or channel" });
  await expect(search).toBeFocused();
  const individual = dialog.getByRole("region", { name: "Individual access" });
  await expect(
    individual.getByText("Bob Fixture", { exact: true }),
  ).toBeVisible();
  await expect(
    individual.getByText("Carol Fixture", { exact: true }),
  ).toBeVisible();
  // The 14 legacy humans plus Alice stay collapsed; Bob and Carol are agents.
  const other = dialog.getByRole("button", {
    name: /Other access.*15 members/,
  });
  await expect(other).toHaveAttribute("aria-expanded", "false");
  await expect(
    dialog.getByText("Existing person 14", { exact: true }),
  ).toHaveCount(0);
  await other.click();
  await expect(
    dialog.getByText("Existing person 14", { exact: true }),
  ).toBeAttached();
  await expect(
    dialog.getByText(/^The original sharing destination/),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    for (const width of [390, 950, 1280]) {
      await page.setViewportSize({ width, height: 620 });
      await page.evaluate(
        (value) => (document.documentElement.dataset.colorMode = value),
        mode,
      );
      await reachable(
        dialog.getByRole("button", { name: "Done", exact: true }),
        { scroll: false },
      );
      await dialog
        .getByText("Existing person 14", { exact: true })
        .scrollIntoViewIfNeeded();
      await reachable(
        dialog.getByRole("button", { name: "Done", exact: true }),
        { scroll: false },
      );
      await page.screenshot({
        path: test.info().outputPath(`legacy-access-${mode}-${width}.png`),
      });
    }
  }
  await other.press("Enter");
  await expect(other).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 1280, height: 850 });
  await search.fill("Alpha");
  await page.getByRole("option", { name: "Alpha", exact: true }).click();
  await expect(
    dialog.getByRole("region", { name: "Selected channel" }),
  ).toContainText("#Alpha");
  const participants = dialog.getByRole("button", {
    name: /#Alpha.*members/,
  });
  await expect(participants).toHaveAttribute("aria-expanded", "false");
  await participants.click();
  await expect(participants).toHaveAttribute("aria-expanded", "true");
  await expect(
    dialog
      .getByRole("region", { name: "Selected channel" })
      .getByText("Alice Fixture", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("session-share-participants-expanded.png"),
  });
  await participants.press("Enter");
  await expect(participants).toHaveAttribute("aria-expanded", "false");
  const share = dialog.getByRole("button", {
    name: "Share",
    exact: true,
  });
  for (const mode of ["light", "dark"]) {
    for (const [width, scale] of [
      [1280, 1],
      [950, 1],
      [390, 1],
      [390, 2],
    ]) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(
        ({ mode, scale }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            String(scale),
          );
        },
        { mode, scale },
      );
      const footer = dialog.locator(".buzz-dialog-actions");
      const copy = dialog.getByRole("button", {
        name: /^(Copy link|Link copied)$/,
      });
      // Each button gets its own flex item. Horizontal overflow is allowed
      // only for a single oversized action, not the combined Copy/Share row.
      await expect
        .poll(() =>
          footer.evaluate((el) => {
            const widest = Math.max(
              ...[...el.querySelectorAll("button")].map(
                (button) => button.getBoundingClientRect().width,
              ),
            );
            // Include the shared focus-ring inset around an oversized action.
            const style = getComputedStyle(el);
            const inset =
              parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
            return el.scrollWidth - Math.max(el.clientWidth, widest + inset);
          }),
        )
        .toBeLessThanOrEqual(1);
      if (scale === 1) {
        await expect
          .poll(() => footer.evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBeLessThanOrEqual(1);
        await reachable(share, { scroll: false });
        await reachable(copy, { scroll: false });
      } else {
        await expect
          .poll(async () => {
            const shared = await share.boundingBox();
            const copied = await copy.boundingBox();
            return shared.y >= copied.y + copied.height;
          })
          .toBe(true);
        // Real Tab still reaches both wrapped controls, without programmatic
        // scrolling or focus bypassing the actual tab order.
        for (const action of [share, copy]) {
          for (
            let step = 0;
            !(await action.evaluate((el) => el === document.activeElement));
            step++
          ) {
            expect(step).toBeLessThan(12);
            await page.keyboard.press("Tab");
            // Base UI returns focus from its guard on the next frame. Do not
            // send another Tab while that handoff is still pending.
            await expect
              .poll(() =>
                page.evaluate(() =>
                  document.activeElement?.hasAttribute(
                    "data-base-ui-focus-guard",
                  ),
                ),
              )
              .toBe(false);
          }
          await expect(action).toBeFocused();
          await expect(action).toBeInViewport({ ratio: 1 });
        }
        await reachable(copy, { scroll: false });
        await page.keyboard.press("Enter");
        await expect
          .poll(
            async () =>
              (await copy.innerText()) === "Link copied" ||
              (await dialog
                .getByRole("alert")
                .filter({ hasText: "Couldn’t copy the link." })
                .count()) > 0,
          )
          .toBe(true);
        await expect(copy).toBeFocused();
      }
      await page.screenshot({
        path: test
          .info()
          .outputPath(`session-share-${mode}-${width}-text-${scale}.png`),
      });
    }
  }
  let failedId;
  let postedId;
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (event.kind !== 9) return route.continue();
    if (!failedId) {
      failedId = event.id;
      return route.fulfill({
        json: {
          accepted: false,
          event_id: event.id,
          message: "Fixture link rejected",
        },
      });
    }
    postedId = event.id;
    return route.continue();
  });
  // Submit the wrapped primary action through its actual keyboard path too.
  await page.keyboard.press("Tab");
  await expect(share).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "Link posting is not confirmed" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );

  await expect(search).toBeDisabled();
  await expect(participants).toHaveAttribute("aria-expanded", "false");
  await expect(
    dialog.getByText("Session participants", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(/^Retry keeps the exact submitted recipients\./),
  ).toHaveCount(0);
  await expect(participants).toContainText("Submitted audience");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(search).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
  await reachable(dialog.getByRole("button", { name: "Retry share" }));
  await dialog.getByRole("button", { name: "Retry share" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(postedId).toBe(failedId);
  const links = app.report.publications.filter(({ event }) => event.kind === 9);
  expect(links).toHaveLength(1);
  expect(links[0].event.id).toBe(failedId);
  expect(links[0].event.content).toBe("[Session: beta](buzz://channel/beta)");
  expect(links[0].event.tags).toContainEqual(["h", "alpha"]);
  expect(links[0].event.tags.filter(([key]) => key === "p")).toHaveLength(0);
  // Reload proves real app wiring to this account/community's device-local history.
  await page.reload();
  await openSession(page, app, "beta");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const reopened = page.getByRole("dialog", { name: "Share session" });
  const recorded = reopened.getByRole("button", { name: /#Alpha.*4 members/ });
  await expect(recorded).toHaveAttribute("aria-expanded", "false");
  await expect(
    reopened.getByText("Session participants", { exact: true }),
  ).toHaveCount(0);
  await expect(
    reopened.getByText("Alice Fixture", { exact: true }),
  ).toHaveCount(0);
  await recorded.click();
  await expect(
    reopened.getByText("Alice Fixture", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("session-share-recorded-expanded.png"),
  });
  await recorded.press("Enter");
  await expect(recorded).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({
    path: test.info().outputPath("session-share-recorded-collapsed.png"),
  });
  await reopened.getByRole("button", { name: "Done", exact: true }).click();
  expect(
    app.report.publications.filter(({ event }) => event.kind === 9),
  ).toHaveLength(1);
});

test("People search holds loading, scrolls portalled results and restores keyboard focus", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto(app.origin);
  await openSession(page, app, "beta");
  const trigger = page.getByRole("button", { name: "Share", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Share session" });
  const search = dialog.getByRole("combobox", { name: "People or channel" });
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
  await page.route("**/api/relay/**/profile-search", async (route) => {
    if (route.request().postDataJSON().query === "Morgan") {
      signal();
      await held;
      return route.fulfill({ json: [...humans, bot] });
    }
    return route.continue();
  });
  try {
    await search.fill("Morgan");
    await requested;
    await expect(
      page.getByText("Searching people…", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(0);
    release();
    const list = page.getByRole("listbox");
    await expect(list.getByRole("option")).toHaveCount(12);
    await expect(list.getByText("Morgan agent")).toHaveCount(0);
    // The portalled picker must be bounded by its modal, not merely the viewport.
    // Only a real browser can prove its painted bounds and scrolled-row hit testing.
    const popup = page.locator(".buzz-select-popup");
    const contained = async () => {
      await expect
        .poll(() =>
          popup.evaluate((element) => {
            const menu = element.getBoundingClientRect();
            const modal = document
              .querySelector('[role="dialog"]')
              .getBoundingClientRect();
            return {
              left: menu.left >= modal.left,
              right: menu.right <= modal.right,
              top: menu.top >= modal.top,
              bottom: menu.bottom <= modal.bottom,
            };
          }),
        )
        .toEqual({ left: true, right: true, top: true, bottom: true });
    };
    for (const mode of ["light", "dark"]) {
      for (const width of [1280, 950, 390]) {
        for (const scale of [1, 2]) {
          await page.setViewportSize({ width, height: 620 });
          await page.evaluate(
            ({ mode, scale }) => {
              document.documentElement.dataset.colorMode = mode;
              document.documentElement.style.setProperty(
                "--buzz-text-scale",
                String(scale),
              );
            },
            { mode, scale },
          );
          await contained();
          const result = list.getByRole("option", {
            name: /Morgan person 9\b/,
          });
          await reachable(result);
          await contained();
          await expect
            .poll(() =>
              popup.evaluate((el) => el.scrollHeight > el.clientHeight),
            )
            .toBe(true);
          await page.screenshot({
            path: test
              .info()
              .outputPath(
                `session-share-results-${mode}-${width}-text-${scale}.png`,
              ),
          });
        }
      }
    }
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "1"),
    );
    await contained();
    await search.press("ArrowDown");
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
    await search.press("Escape");
    await expect(list).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(search).toHaveValue("Morgan");
    await search.press("ArrowDown");
    await expect(list.getByRole("option")).toHaveCount(12);
    const keyboardChoice = list.getByRole("option", {
      name: /Morgan person 1\b/,
    });
    const choiceId = await keyboardChoice.getAttribute("id");
    for (
      let step = 0;
      (await search.getAttribute("aria-activedescendant")) !== choiceId;
      step++
    ) {
      expect(step).toBeLessThan(13);
      await search.press("ArrowDown");
    }
    await expect(keyboardChoice).toHaveAttribute("data-highlighted", "");
    await search.press("Enter");
    const selected = dialog.getByRole("region", { name: "Selected people" });
    await expect(selected).toContainText("Morgan person 1");
    await expect(selected).not.toContainText(formatPublicKey(humans[0].pubkey));
    await selected
      .getByRole("button", { name: "Remove Morgan person 1", exact: true })
      .click();
    await expect(selected).toHaveCount(0);
    await search.fill("Morgan");
    await expect(list.getByRole("option")).toHaveCount(12);
    await list.getByRole("option", { name: /Morgan person 2\b/ }).click();
    await expect(
      dialog.getByRole("region", { name: "Selected people" }),
    ).toContainText("Morgan person 2");
    await expect(dialog).toBeVisible();
    await search.focus();
    await search.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
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
    // The fixture relay's name search finds the served profile.
    app.serveProfile(generateSecretKey(), { name: "Aria" });
    await page.goto(app.origin);
    await openSession(page, app, "alpha");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share session" });
    await dialog
      .getByRole("combobox", { name: "People or channel" })
      .fill("Gamma");
    await page.getByRole("option", { name: "Gamma", exact: true }).click();
    await dialog
      .getByRole("combobox", { name: "People or channel" })
      .fill("Aria");
    await page.getByRole("option", { name: /Aria/ }).click();
    await expect(
      dialog.getByRole("region", { name: "Selected people" }),
    ).toBeVisible();
    await openSession(page, app, "beta");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      dialog.getByRole("combobox", { name: "People or channel" }),
    ).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeEnabled();
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
    await expect(
      dialog.getByRole("combobox", { name: "People or channel" }),
    ).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeEnabled();
    // Another message visit in the same source also discards unsent UI.
    await dialog
      .getByRole("combobox", { name: "People or channel" })
      .fill("Gamma");
    await page.getByRole("option", { name: "Gamma", exact: true }).click();
    const next = app.append(
      "primary",
      "alpha",
      "A new visit in the same session",
    );
    await openSession(page, app, "alpha", next.id);
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      dialog.getByRole("combobox", { name: "People or channel" }),
    ).toHaveValue("");
  });
});
