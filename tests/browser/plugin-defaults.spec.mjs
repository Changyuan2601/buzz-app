import { openCommunityPicker } from "./navigation.mjs";
import { openPage, selectSettingsSection } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function plugins(page) {
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
}

// Representative app wiring: real catalogs -> Settings switches -> sidebar page,
// across reload. Choice permutations live in storage unit tests.
test("Bestie opts in without changing the other bundled defaults and survives reload", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(button(page, "Bestie")).toHaveCount(0);
  await plugins(page);
  const bestie = page.getByRole("switch", {
    name: "Enable Bestie",
    exact: true,
  });
  await expect(bestie).not.toBeChecked();
  for (const name of ["GitHub", "Terminal", "Workflows", "Hosted communities"])
    await expect(
      page.getByRole("switch", { name: `Enable ${name}`, exact: true }),
    ).toBeChecked();
  await bestie.click();
  await expect(bestie).toBeChecked();
  await page.reload();
  await expect(bestie).toBeChecked();
  await openPage(page, "Messages");
  await expect(
    page
      .locator(".shell-header")
      .getByRole("button", { name: "Bestie", exact: true }),
  ).toHaveCount(0);
  const destination = page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Bestie", exact: true });
  await expect(destination).toBeVisible();
  await destination.click();
  await expect(
    page.getByRole("heading", { name: "Meet your Bestie" }),
  ).toBeVisible();
  await plugins(page);
  await bestie.click();
  await expect(bestie).not.toBeChecked();
  await page.reload();
  await expect(bestie).not.toBeChecked();
  await expect(button(page, "Bestie")).toHaveCount(0);
});

// Real App -> shell -> rail Settings-registry wiring, including the scoped
// destination. Role and contribution-removal permutations stay in jsdom.
test("Community admin toggle removes and restores the working Invite destination", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.every((filter) => filter.kinds?.includes(13534)))
      return route.fulfill({ json: [app.membershipSnapshot("owner")] });
    return route.continue();
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const invite = page.getByRole("menuitem", {
    name: "Invite to community",
    exact: true,
  });
  const menu = async () => {
    await openCommunityPicker(page);
    await button(page, "Switch to Primary").click({ button: "right" });
    await expect(
      page.getByRole("menu", { name: "Actions for Primary" }),
    ).toBeVisible();
  };
  await menu();
  await expect(invite).toBeVisible();
  await page.keyboard.press("Escape");
  await plugins(page);
  const admin = page.getByRole("switch", {
    name: "Enable Community admin",
    exact: true,
  });
  await admin.click();
  await expect(admin).not.toBeChecked();
  await menu();
  await expect(invite).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Community settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await admin.click();
  await expect(admin).toBeChecked();
  await menu();
  await invite.click();
  await expect(
    page.getByRole("heading", { name: "Membership", exact: true }),
  ).toBeVisible();
});
