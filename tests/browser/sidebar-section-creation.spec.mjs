import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

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
  await field.fill("Launch");
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
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag source missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, {
    steps: 3,
  });
}

async function dropOnCreate(page) {
  const target = page.locator("[data-create-section-drop]");
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error("Create target missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
}

test("channel drags reveal Create section, cancel safely, and create-and-move on submission", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const target = page.locator("[data-create-section-drop]");
  const row = page.locator('[data-channel-id="alpha"]');
  await expect(target).toHaveCount(0);
  await startDrag(page, row);
  await expect(target).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(target).toHaveCount(0);
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await startDrag(page, row);
  await dropOnCreate(page);
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(field).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await startDrag(page, row);
  await dropOnCreate(page);
  await expect(field).toBeFocused();
  await field.fill("Release");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).toHaveCount(0);
  const section = page
    .locator("[data-sidebar-section]")
    .filter({ has: page.locator("summary").filter({ hasText: /^Release$/ }) });
  await expect(section.locator('[data-channel-id="alpha"]')).toBeVisible();
  await expect(row).toBeFocused();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  await page.reload();
  await openPage(page, "Messages");
  await expect(section.locator('[data-channel-id="alpha"]')).toBeVisible();
  // The original per-channel creation entry remains available.
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .hover();
  await expect(
    page.getByRole("menuitem", { name: "Create new…", exact: true }),
  ).toBeVisible();
});
