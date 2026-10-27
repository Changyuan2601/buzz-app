import { test, expect } from "./fixture.mjs";
import { openPage, settleShellToggle } from "./navigation.mjs";

// Browser ownership: real pointer collision/activation, menu-to-modal focus,
// relocation and cold reload through the production preference broker.
// Input/error permutations remain in the colocated component/store tests.
test.use({ productionBroker: true, savedSidebar: true, largeSidebar: false });

test("Channels offers empty-section creation with keyboard focus and confirmed persistence", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const trigger = page.getByRole("button", {
    name: "More actions for Channels",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem"),
  ).toHaveText(["Filter", "Sort", "Create section"]);
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.type("Launch");
  await expect(field).toHaveValue("Launch");
  await field.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(
    page.locator("summary").filter({ hasText: /^Launch$/ }),
  ).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const { blob } = app.report.sidebarPublications[0];
  expect(blob.assignments).toEqual({ beta: "work" });
  expect(Object.keys(blob.meta.a)).not.toContain("undefined");
  await page.reload();
  await openPage(page, "Messages");
  await expect(
    page.locator("summary").filter({ hasText: /^Launch$/ }),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-sidebar-section="group:work"] [data-channel-id="beta"]',
    ),
  ).toBeVisible();
});

async function startDrag(page, locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag source missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, {
    steps: 3,
  });
}

async function dropOnCreate(page) {
  await revealCreate(page);
  const target = page.locator("[data-create-section-drop]");
  // Bring the actual target into view before releasing; at enlarged text its
  // lower edge can sit outside the narrow sidebar's scrollport.
  await target.hover();
  await expect(page.locator('[class*="channelDragOverlay"]')).toBeHidden();
  await page.mouse.up();
}

async function revealCreate(page) {
  const trigger = page.locator("[data-create-section-trigger]");
  const box = await trigger.boundingBox();
  if (!box) throw new Error("Create boundary missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 4,
  });
  await expect(page.locator("[data-create-section-drop]")).toBeVisible();
  // Observe completion rather than releasing into still-expanding geometry.
  await expect
    .poll(() =>
      page
        .locator("[data-create-section-drop]")
        .evaluate((node) => node.parentElement.style.height),
    )
    .toBe("auto");
}

test("only the top channel-section boundary reveals creation, latches, cancels and saves first", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const target = page.locator("[data-create-section-drop]");
  const row = page.locator('[data-channel-id="alpha"]');
  await expect(target).toHaveCount(0);
  await startDrag(page, row);
  await expect(page.locator("[data-section-creation-preview]")).toBeVisible();
  await expect(page.locator("[data-section-creation-preview]")).not.toHaveCSS(
    "translate",
    "none",
  );
  await expect(target).toHaveCount(0);
  // Channels is not first when Work exists: its old gap is an ordinary move area.
  const channels = page.locator('[data-sidebar-section="channels"]');
  const channelsBox = await channels.boundingBox();
  if (!channelsBox) throw new Error("Channels destination missing");
  await page.mouse.move(
    channelsBox.x + channelsBox.width / 2,
    channelsBox.y - 8,
  );
  await page.mouse.move(
    channelsBox.x + channelsBox.width / 2,
    channelsBox.y + 12,
  );
  await expect(channels).toHaveAttribute("data-drop-target", "true");
  await expect(target).toHaveCount(0);
  await expect(
    page.locator("[data-create-section-slot] + [data-sidebar-section]"),
  ).toHaveAttribute("data-sidebar-section", "group:work");
  await revealCreate(page);
  await page
    .locator(".shell-sidebar")
    .screenshot({ path: testInfo.outputPath("top-section-target.png") });
  await page.evaluate(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-appearance.v1",
        newValue: "dark",
        storageArea: localStorage,
      }),
    );
  });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.locator(".shell-sidebar").screenshot({
    path: testInfo.outputPath("top-section-target-dark.png"),
  });
  // Leaving the gap must not collapse it or prevent an ordinary section move.
  const work = page.locator('[data-sidebar-section="group:work"] summary');
  const workBox = await work.boundingBox();
  if (!workBox) throw new Error("Work destination missing");
  await page.mouse.move(
    workBox.x + workBox.width / 2,
    workBox.y + workBox.height / 2,
  );
  await expect(target).toBeVisible();
  await expect(
    page.locator('[data-sidebar-section="group:work"]'),
  ).toHaveAttribute("data-drop-target", "true");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(target).toHaveCount(0);
  // The cue retires before its height finishes collapsing. Wait for the layout
  // boundary before sampling Work's header for the next pointer gesture.
  await expect(page.locator("[data-create-section-trigger] + div")).toHaveCSS(
    "height",
    "0px",
  );
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  // A lone saved section is not reorderable and cannot reveal creation.
  await startDrag(page, work);
  await expect(page.locator("[data-section-creation-preview]")).toHaveCount(0);
  await expect(target).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  // Release as soon as the original gap accepts the drop, without waiting for
  // expansion. dnd-kit drops on its rendered target, not the last mouse event.
  await startDrag(page, row);
  const gap = await page.locator("[data-create-section-trigger]").boundingBox();
  if (!gap) throw new Error("Create boundary missing");
  await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2);
  await expect(target).toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "Move to new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(field).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await startDrag(page, row);
  await dropOnCreate(page);
  await expect(field).toBeFocused();
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await expect(field).toBeFocused();
  await page.keyboard.type("Release");
  await expect(field).toHaveValue("Release");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).toHaveCount(0);
  const section = page
    .locator("[data-sidebar-section]")
    .filter({ has: page.locator("summary").filter({ hasText: /^Release$/ }) });
  await expect(section.locator('[data-channel-id="alpha"]')).toBeVisible();
  await expect(
    page.locator('[data-sidebar-section^="group:"] summary'),
  ).toHaveText(["Release", "Work"]);
  await expect(row).toBeFocused();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  await page.reload();
  await openPage(page, "Messages");
  await expect(section.locator('[data-channel-id="alpha"]')).toBeVisible();
  await expect(
    page.locator('[data-sidebar-section^="group:"] summary'),
  ).toHaveText(["Release", "Work"]);
  await page.locator(".shell-sidebar").screenshot({
    path: testInfo.outputPath("created-section-first.png"),
  });
  // The original per-channel creation entry remains available.
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .hover();
  await expect(
    page.getByRole("menuitem", { name: "Create new…", exact: true }),
  ).toBeVisible();
});

test.describe("without saved sections", () => {
  test.use({ savedSidebar: false });

  // Only a layout engine proves that the first-section gap is reachable in the
  // host sidebar, including its scrollport, enlarged text and immediate motion.
  test("the first Channels boundary works with reduced motion in a narrow sidebar", async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto(app.origin);
    await page.evaluate(() => {
      localStorage.setItem("buzz-font-scale.v1", "2");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "buzz-font-scale.v1",
          newValue: "2",
          storageArea: localStorage,
        }),
      );
    });
    await openPage(page, "Messages");
    await settleShellToggle(page);
    await page
      .getByRole("button", { name: "Show navigation", exact: true })
      .click();
    await expect(page.locator('[data-sidebar-section="starred"]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-sidebar-section^="group:"]')).toHaveCount(
      0,
    );
    await startDrag(page, page.locator('[data-channel-id="alpha"]'));
    await dropOnCreate(page);
    const dialog = page.getByRole("dialog", { name: "Move to new section" });
    await expect(
      dialog.getByRole("textbox", { name: "Section name" }),
    ).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  });
});
