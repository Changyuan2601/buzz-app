import { verifyEvent } from "nostr-tools";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({
  channelWriteKinds: [9, 9007, 40100],
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only contract: retained native editor selection, modal hit-testing,
// focus return, responsive layout, and the real session/outbox/signer wiring.
// Pagination/race/error matrices stay in component and capability tests.
test("Canvas history previews and restores without losing the editor draft", async ({
  page,
  app,
}, testInfo) => {
  const old = app.sign({
    kind: 40100,
    content: "# Earlier notes",
    tags: [["h", "alpha"]],
    created_at: 1700000000,
  });
  let head = app.sign({
    kind: 40100,
    content: "# Current notes",
    tags: [["h", "alpha"]],
    created_at: 1700000001,
  });
  const events = [head, old];
  const writes = [];
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      !filters.every(
        (f) =>
          f.kinds?.includes(40100) ||
          f.ids?.some((id) => events.some((event) => event.id === id)),
      )
    )
      return route.continue();
    return route.fulfill({
      json: filters.flatMap((f) =>
        events
          .filter(
            (event) =>
              (!f.ids || f.ids.includes(event.id)) &&
              (!f.until ||
                event.created_at < f.until ||
                (event.created_at === f.until &&
                  (!f.before_id || event.id > f.before_id))),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, f.limit),
      ),
    });
  });
  await page.route("**/api/relay/primary/sign", async (route) =>
    route.fulfill({ json: app.sign(route.request().postDataJSON()) }),
  );
  await page.route("**/api/relay/primary/publish", async (route) => {
    const event = route.request().postDataJSON();
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toContainEqual(["expected-revision", head.id]);
    expect(event.id).not.toBe(old.id);
    head = event;
    events.unshift(event);
    writes.push(event);
    await route.fulfill({ json: { accepted: true, event_id: event.id } });
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "Channel actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "View canvas", exact: true })
    .click();
  const dialog = page.getByRole("region", {
    name: "Channel Canvas",
    exact: true,
  });
  const editor = dialog.getByRole("textbox", {
    name: "Canvas Markdown",
    exact: true,
  });
  await expect(editor).toHaveValue("# Current notes");
  await editor.fill("My unsaved draft");
  await editor.evaluate((element) => element.setSelectionRange(3, 10));
  await dialog.getByRole("tab", { name: "History", exact: true }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await dialog.getByRole("radio").last().click();
  await expect(
    dialog.getByRole("textbox", { name: "Revision Markdown" }),
  ).toHaveValue(old.content);
  await expect(
    dialog.getByRole("button", { name: "Restore this version", exact: true }),
  ).toBeEnabled();
  await dialog.screenshot({ path: testInfo.outputPath("canvas-history.png") });
  const restore = dialog.getByRole("button", {
    name: "Restore this version",
    exact: true,
  });
  await restore.click();
  const confirmation = page.getByRole("dialog", {
    name: "Restore this version?",
    exact: true,
  });
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.mouse.click(8, 8);
  await expect(confirmation).toHaveCount(0);
  await expect(restore).toBeFocused();
  await dialog.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(editor).toHaveValue("My unsaved draft");
  expect(
    await editor.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([3, 10]);
  await dialog.getByRole("tab", { name: "History", exact: true }).click();
  await dialog.getByRole("radio").last().click();
  await restore.click();
  await confirmation
    .getByRole("button", { name: "Restore version", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveText(
    "Version restored as a new revision.",
  );
  await expect(
    dialog.getByRole("button", { name: "Refresh history" }),
  ).toBeFocused();
  expect(writes).toHaveLength(1);
  expect(head.content).toBe(old.content);
  await dialog.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(editor).toHaveValue("My unsaved draft");
  await expect(
    dialog.getByRole("button", { name: "Save Canvas", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText(
    "unsaved draft is kept",
  );
  await page.evaluate(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
    document.documentElement.dataset.colorMode = "dark";
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("tab", { name: "History", exact: true }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  await dialog.screenshot({
    path: testInfo.outputPath("canvas-history-narrow.png"),
  });
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});
