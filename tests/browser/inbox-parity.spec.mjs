import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Exercises the registered Inbox plugin, real profile contribution and portal focus.
// Leaf renderer tests cannot prove that the page supplies the host services.
test("the same signed mention opens its profile in Inbox and Channels", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const message = app.append(
    "primary",
    "alpha",
    "@Fixture Reader shared mention",
    true,
    false,
    root.id,
    undefined,
    [["p", app.viewer]],
  );
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  // The thread's preview follows whichever reply loaded last.
  // Enter enters the detail, so the exact reveal takes focus.
  await inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("button", { name: "Open Alice Fixture in #Alpha", exact: true })
    .press("Enter");
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  // A pending exact reveal would take focus from the profile dialog below.
  await expect(detail.locator("[data-message-id]:focus")).toHaveCount(1);
  const row = detail.locator(`[data-message-id="${message.id}"]`);
  const mention = row.getByRole("button", {
    name: "View Fixture Reader profile",
    exact: true,
  });
  await expect(row).toContainText("shared mention");
  await expect(mention).toBeVisible();
  const composer = detail.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await composer.fill("Preserved Inbox reply");
  await mention.focus();
  await mention.press("Enter");
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  // The dialog owns entry focus; an earlier Escape would reach Inbox detail.
  const entered = () =>
    expect
      .poll(() =>
        profile.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
  await expect(profile).toBeVisible();
  await expect(profile).toContainText("Fixture Reader");
  await entered();
  await page.keyboard.press("Escape");
  await expect(mention).toBeFocused();
  await expect(composer).toHaveJSProperty("value", "Preserved Inbox reply");
  await page.setViewportSize({ width: 560, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addStyleTag({ content: "html { font-size: 125%; }" });
  await mention.click();
  await expect(profile).toBeVisible();
  await entered();
  await page.keyboard.press("Escape");
  await expect(mention).toBeFocused();
  await expect(composer).toHaveJSProperty("value", "Preserved Inbox reply");
  await detail
    .getByRole("button", { name: "Open in channel", exact: true })
    .click();
  const channelRow = page
    .locator(`[data-message-id="${message.id}"]`)
    .filter({ visible: true });
  await channelRow
    .getByRole("button", { name: "View Fixture Reader profile", exact: true })
    .click();
  await expect(
    page.getByText("Fixture Reader", { exact: true }).last(),
  ).toBeVisible();
});
