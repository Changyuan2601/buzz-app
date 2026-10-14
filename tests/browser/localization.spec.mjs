// Browser-only boundaries: the real navigator locale at startup, persistence
// across reload, and inherited language metadata in the composed app.
import { selectSettingsSection } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ locale: "pt-BR" });

const lang = (locator) =>
  locator.evaluate((node) => node.closest("[lang]")?.getAttribute("lang"));

test("Language starts from the browser locale, keeps untranslated copy English, and saves a choice", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Configurações", level: 1 }),
  ).toHaveCount(1);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await selectSettingsSection(page, "Notificações", "Notifications");
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  expect(await lang(notifications)).toBe("en");

  await selectSettingsSection(page, "Idioma");
  const picker = page.getByRole("combobox", { name: "Idioma do aplicativo" });
  expect(await lang(picker)).toBe("pt-BR");
  await picker.click();
  await page
    .getByRole("option", { name: "English (United States)", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Language", exact: true }),
  ).toBeVisible();

  // The saved choice outranks the browser's Portuguese preference.
  await page.reload();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toHaveCount(1);
});
