import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  historyCounts: { alpha: 1, beta: 0 },
  detailsMessage: `The sidebar keeps its place.\n\n${"It holds while channels load. ".repeat(30)}`,
});

// Only a real engine lays the sheet out around the composer and decides which
// surface a press at the composer reaches; jsdom has neither layout nor paint.
test("details grow out of the composer, which stays usable above them", async ({
  page,
  app,
}) => {
  await open(page, app);
  const more = page.getByRole("button", { name: "Show more" });
  await more.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const composer = page.locator("[data-message-composer]");
  // The settled sheet surrounds the composer: no growth animation is running.
  await expect
    .poll(() =>
      sheet.evaluate((element) =>
        element.getAnimations().some((a) => a.playState === "running"),
      ),
    )
    .toBe(false);
  const [outer, inner] = [
    await sheet.boundingBox(),
    await composer.boundingBox(),
  ];
  expect(outer.x).toBeLessThan(inner.x);
  expect(outer.x + outer.width).toBeGreaterThan(inner.x + inner.width);
  expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
  expect(outer.y).toBeLessThan(inner.y - 200);
  // The composer paints above the sheet and takes a reply without closing it.
  expect(
    await composer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return element.contains(hit);
    }),
  ).toBe(true);
  const reply = page.getByRole("textbox", { name: "Message #Alpha" });
  await reply.click();
  await reply.pressSequentially("Thanks");
  await expect(sheet).toBeVisible();
  await reply.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("Thanks");
});

// Real hit testing proves the replacement composer is above the scrim, while
// the channel draft remains mounted and cannot receive the thread reply.
test("thread sheet keeps its reply composer usable and restores the channel draft", async ({
  page,
  app,
}) => {
  await open(page, app);
  const channelEditor = page.getByRole("textbox", { name: "Message #Alpha" });
  await channelEditor.fill("Channel draft");
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator("[data-message-id]")
    .first();
  const rootId = await row.getAttribute("data-message-id");
  const sourceComposer = page.locator("[data-message-composer]").first();
  let release, observed;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit || filter.ids)
    )
      return route.continue();
    observed();
    await held;
    await route.continue().catch(() => {});
  });
  const sheet = page.getByRole("dialog", { name: "Thread", exact: true });
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches("[data-contained-composer]")) {
        Element.prototype.animate = animate;
        animation.pause();
        animation.currentTime = 0;
      }
      return animation;
    };
  });
  try {
    await hoverMessage(row);
    await row.getByRole("button", { name: "Reply", exact: true }).click();
    await started;
    await expect(sheet).toBeVisible();
    // Opening a known root must paint its cached message and scoped editor
    // while the real network gate still holds the reply refresh back.
    await expect(sheet.locator(`[data-message-id="${rootId}"]`)).toBeVisible();
    await expect(sheet.getByRole("textbox")).toBeVisible();
    // Hold the opening at its folded boundary after cached content mounts.
    // Its header must still be clipped, while the bottom editor stays painted.
    expect(
      await sheet.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 10),
        );
      }),
    ).toBe(false);
  } finally {
    await sheet.evaluate((element) =>
      element.getAnimations().forEach((animation) => {
        animation.play();
      }),
    );
    release();
  }
  const reply = sheet.getByRole("textbox");
  await reply.fill("Thread draft");
  await expect(reply).toHaveText("Thread draft");
  await expect(reply).toBeInViewport();
  await expect(channelEditor).toBeHidden();
  // Hold the actual exit mid-flight, not an arbitrary sleep after clicking.
  await sheet.evaluate((element) => {
    element.addEventListener(
      "click",
      () =>
        requestAnimationFrame(() => {
          const animations = element.getAnimations();
          for (const animation of animations) {
            animation.pause();
            animation.currentTime =
              Number(animation.effect.getTiming().duration) / 2;
          }
          element.dataset.exitSampled = String(animations.length);
        }),
      { once: true },
    );
  });
  try {
    await sheet
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(sheet).toHaveAttribute("data-exit-sampled", /^[1-9]/);
    await expect(sourceComposer).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("thread-sheet-exit.png"),
    });
  } finally {
    await sheet.evaluate((element) =>
      element.getAnimations().forEach((animation) => {
        animation.play();
      }),
    );
  }
  await expect(sheet).toBeHidden();
  await expect(channelEditor).toBeVisible();
  await expect(channelEditor).toHaveText("Channel draft");
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(sheet.getByRole("textbox")).toHaveText("Thread draft");
  await expect
    .poll(() =>
      sheet.evaluate((element) =>
        element
          .getAnimations()
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
  await sheet.getByRole("textbox").press("Escape");
  await expect(sheet).toBeHidden();
  await expect(channelEditor).toHaveText("Channel draft");
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(sheet.getByRole("textbox")).toHaveText("Thread draft");
  const shortHeight = (await sheet.boundingBox()).height;
  await page.screenshot({
    path: test.info().outputPath("thread-sheet-short.png"),
  });
  const longReply = app.append(
    "primary",
    "alpha",
    "Long thread reply\n".repeat(80),
    true,
    false,
    rootId,
  );
  await expect(
    sheet.locator(`[data-message-id="${longReply.id}"]`),
  ).toBeAttached();
  await expect
    .poll(() =>
      sheet.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(shortHeight);
  const history = sheet.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect
    .poll(() =>
      history.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  expect(
    await sheet.evaluate(
      (element) =>
        element.getBoundingClientRect().height <=
        Number.parseFloat(getComputedStyle(element).maxHeight) + 1,
    ),
  ).toBe(true);
  await expect(sheet.getByRole("textbox")).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath("thread-sheet-long.png"),
  });
  await sheet.getByRole("textbox").press("Escape");
  await expect(sheet).toBeHidden();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    sheet.locator(`[data-message-id="${longReply.id}"]`),
  ).toBeAttached();
  await expect(history).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() => history.evaluate((element) => element.scrollTop))
    .toBe(0);
  await sheet
    .getByRole("button", { name: "Open thread in tab", exact: true })
    .click();
  await expect(sheet).toBeHidden();
  await expect(
    page.locator(
      '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toHaveText("Thread draft");
});

test.describe("image comments", () => {
  test.use({ productionBroker: true });

  test("photo opens above an editable comment composer", async ({
    page,
    app,
  }) => {
    const picture = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      context.fillStyle = "#4d80b0";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.route("**/api/relay/primary/media?**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(picture, "base64"),
      }),
    );
    await open(page, app);
    const event = app.append(
      "primary",
      "alpha",
      "Photo to discuss",
      true,
      true,
      undefined,
      undefined,
      [["imeta", "url https://primary.example/media/photo.png", "m image/png"]],
    );
    const row = page
      .getByRole("region", { name: "Channel message history" })
      .locator(`[data-message-id="${event.id}"]`);
    let release, observed;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      observed = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.depth_limit || filter.ids)
      )
        return route.continue();
      observed();
      await held;
      await route.continue().catch(() => {});
    });
    await row.getByRole("link", { name: "Open image attachment" }).click();
    const sheet = page.getByRole("dialog", { name: "photo.png" });
    const stage = sheet.locator("[data-review-stage]");
    let loadingBounds;
    let pendingEditor;
    let composerBounds;
    try {
      await started;
      await sheet
        .getByRole("textbox", { name: "Reply to thread" })
        .fill("Photo comment draft");
      pendingEditor = await sheet
        .getByRole("textbox", { name: "Reply to thread" })
        .elementHandle();
      await sheet
        .getByRole("textbox", { name: "Reply to thread" })
        .press("Enter");
      await expect(
        sheet.getByRole("textbox", { name: "Reply to thread" }),
      ).toHaveText("Photo comment draft");
      await expect(
        sheet.getByRole("img", { name: "Attachment preview" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          sheet.evaluate((element) =>
            element
              .getAnimations()
              .some((animation) => animation.playState === "running"),
          ),
        )
        .toBe(false);
      loadingBounds = await stage.boundingBox();
      composerBounds = await sheet
        .locator("[data-message-composer]")
        .boundingBox();
    } finally {
      release();
    }
    const comment = sheet.getByRole("textbox", { name: "Reply to thread" });
    await expect(sheet.getByText("Loading comments…")).toHaveCount(0);
    await expect(comment).toHaveText("Photo comment draft");
    expect(await pendingEditor.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    const readyComposerBounds = await sheet
      .locator("[data-message-composer]")
      .boundingBox();
    expect(readyComposerBounds.y).toBeCloseTo(composerBounds.y, 0);
    const readyBounds = await stage.boundingBox();
    expect(readyBounds.height).toBeCloseTo(loadingBounds.height, 0);
    expect(readyBounds.y).toBeCloseTo(loadingBounds.y, 0);
    await expect(comment).toBeInViewport();
    await expect(
      sheet.getByRole("button", { name: "Zoom in", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("photo-sheet.png") });
    await sheet
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      sheet.getByText("Photo comment draft", { exact: true }),
    ).toBeVisible();
    expect((await stage.boundingBox()).height).toBeCloseTo(
      readyBounds.height,
      0,
    );
    const commentsBounds = await sheet
      .getByRole("complementary", { name: "Media comments" })
      .boundingBox();
    expect(commentsBounds.x).toBeGreaterThanOrEqual(
      readyBounds.x + readyBounds.width - 1,
    );
    await expect(comment).toBeInViewport();
    await expect(comment).toBeEmpty();
    await page.screenshot({
      path: test.info().outputPath("photo-sheet-commented.png"),
    });
    await sheet.getByRole("button", { name: "Close media viewer" }).click();
    await expect(sheet).toBeHidden();
    await row.getByRole("link", { name: "Open image attachment" }).click();
    await expect(
      sheet.getByText("Photo comment draft", { exact: true }),
    ).toBeVisible();
    expect((await stage.boundingBox()).width).toBeCloseTo(readyBounds.width, 0);
    await sheet.getByRole("button", { name: "Close media viewer" }).click();
    await expect(sheet).toBeHidden();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha" }),
    ).toBeVisible();
  });
});
