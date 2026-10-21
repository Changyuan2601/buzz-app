import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Real browser Select hit testing and narrow wrapping are not jsdom contracts.
// Recipient/revision/failure matrices belong to primary.test.ts.
test("primary settings remain usable at narrow widths and preserve the mention-only opt-out", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/fixtures/solo-primary.html");
  const settings = page.getByRole("combobox", { name: "Primary agent" });
  await expect(settings).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message #Planning" });
  await input.fill("Help me plan");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.soloPrimaryFixture.published().length),
    )
    .toBe(1);
  await expect(input).toHaveText("");
  await page.getByRole("button", { name: "Use mentions only" }).click();
  const optedOut = page.getByRole("button", {
    name: "Enable automatic replies",
  });
  await expect(optedOut).toBeVisible();
  await input.fill("A new untagged draft after opting out");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await input.press("Enter");
  await expect(input).toHaveText("");
  const sent = await page.evaluate(() => window.soloPrimaryFixture.published());
  expect(sent).toHaveLength(2);
  expect(sent[1].content).toBe("A new untagged draft after opting out");
  expect(
    sent[1].tags.some(([name]) => name === "p" || name === "primary"),
  ).toBe(false);
  await settings.click();
  await expect(
    page.getByRole("option", { name: "Honey", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  expect(errors.unexplained()).toEqual([]);
});

test("explains owner-only adoption before the first selection and finishes the live label refresh", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/solo-primary.html?legacy");
  await expect(
    page.getByText(
      "Adopting a primary makes its replies owner-only. Other agents still reply when tagged.",
    ),
  ).toBeVisible();
  const settings = page.getByRole("combobox", { name: "Primary agent" });
  await settings.click();
  await page.getByRole("option", { name: "Honey", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Use mentions only" }),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message #Planning" });
  await input.fill("First adopted request");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.soloPrimaryFixture.published().length),
    )
    .toBe(1);
});
