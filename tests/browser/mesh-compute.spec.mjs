import { selectSettingsSection } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// Browser boundary: enabling the opt-in Mesh plugin must expose its consumer view in Settings → Compute.
test("enabling Mesh compute opens Settings Compute", async ({ page, app }) => {
  await page.goto(app.origin);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  const enabled = page.getByRole("switch", {
    name: "Enable Shared compute",
    exact: true,
  });
  await enabled.click();
  await expect(enabled).toBeChecked();
  // Contributed cards own their region label rather than the built-in section wrapper.
  await page
    .getByRole("complementary", { name: "Settings sidebar", exact: true })
    .getByRole("button", { name: "Shared compute", exact: true })
    .click();
  const compute = page
    .getByRole("complementary", { name: "Settings sidebar", exact: true })
    .getByRole("button", { name: "Shared compute", exact: true });
  await expect(compute.locator("xpath=ancestor::section[1]")).toContainText(
    "Primary",
  );
  await expect(
    page
      .getByRole("complementary", { name: "Settings sidebar", exact: true })
      .getByText("Shared compute", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Shared compute", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Compute consumer", exact: true })
      .getByRole("status")
      .filter({ hasText: "Open Buzz desktop to use shared compute." }),
  ).toHaveText("Open Buzz desktop to use shared compute.");
  await expect(
    page.getByText("Shared compute for Primary", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Community mesh", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Compute connected in/)).toHaveCount(0);
  await expect(button("Connect to community compute")).toHaveCount(0);
  await expect(page.getByText("This destination couldn’t open")).toHaveCount(0);
});
