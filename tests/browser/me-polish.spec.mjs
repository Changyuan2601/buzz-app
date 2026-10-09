import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const id = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
// Real pointer/keyboard menu behavior, dialog focus and pane geometry require a browser.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [id, other],
  channelNames: { [id]: "Alpha", [other]: "Beta" },
  sessionChannels: [id, other],
  meChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1 },
});

test("Me has full-width chat and matching context/overflow actions without navigating", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await expect(row).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(composer).toBeVisible();
  for (const scale of [1, 2]) {
    await page.evaluate(
      (value) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(value),
        ),
      scale,
    );
    await expect
      .poll(() =>
        composer.evaluate(
          (el) =>
            el.closest("form").getBoundingClientRect().width /
            el.closest("section").getBoundingClientRect().width,
        ),
      )
      .toBeGreaterThan(0.9);
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Alpha",
    exact: true,
  });
  await expect(menu).toBeVisible();
  const actions = await menu.getByRole("menuitem").allTextContents();
  expect(actions).toContain("Share…");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "New conversation", exact: true }),
  ).toBeVisible();
  await expect(row).toBeFocused();
  await sidebar
    .getByRole("button", { name: "Actions for Alpha", exact: true })
    .click();
  await expect(menu).toBeVisible();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(actions);
  await page.keyboard.press("Escape");
  await row.focus();
  await row.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Share conversation",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Alpha");
  await expect(
    dialog.getByRole("switch", { name: "Private", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    dialog.getByRole("button", { name: "Share", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("me-share.png") });
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await row.click();
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  for (const scale of [1, 2]) {
    await page.evaluate(
      (value) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(value),
        ),
      scale,
    );
    await expect
      .poll(() =>
        composer.evaluate((el) => {
          const pane = el
            .closest("[data-attachment-drop-zone]")
            .getBoundingClientRect();
          return el.closest("form").getBoundingClientRect().width / pane.width;
        }),
      )
      .toBeGreaterThan(0.9);
    await expect(composer).toBeInViewport();
  }
  await page.screenshot({ path: test.info().outputPath("me-full-width.png") });
});

test("moving a conversation expands unfiled Conversations and keeps keyboard focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New group…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Section name" }).fill("Work");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(sidebar.getByText("Saving section…")).not.toBeVisible();
  await expect(sidebar.getByRole("alert")).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Work", exact: true }),
  ).toBeVisible();
  const unfiled = sidebar.getByRole("button", {
    name: "Conversations",
    exact: true,
  });
  await unfiled.click();
  await expect(unfiled).toHaveAttribute("aria-expanded", "false");
  await row.focus();
  await row.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move to", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("menuitem", { name: "Conversations", exact: true })
    .click();
  await expect(unfiled).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "New conversation", exact: true }),
  ).toBeVisible();
});

test("Share promotes the same conversation and opens its preserved history in Messages", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  await sidebar
    .getByRole("button", { name: "Alpha", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share conversation" });
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Shared Alpha");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Shared Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(app.report.detailsPublications).toHaveLength(1);
  expect(app.report.detailsPublications[0].tags).toEqual([
    ["h", id],
    ["name", "Shared Alpha"],
    ["about", ""],
  ]);
  expect(app.report.publications).toHaveLength(0);
  await openPage(page, "Me");
  await expect(
    sidebar.getByRole("button", { name: "Shared Alpha", exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
});
