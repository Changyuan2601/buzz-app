// Browser-only boundaries: the real navigator locale at startup, persistence
// across reload, and inherited language metadata in the composed app.
import { selectSettingsSection } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ locale: "pt-BR" });

const lang = (locator) =>
  locator.evaluate((node) => node.closest("[lang]")?.getAttribute("lang"));
const ptNames = { profile: "Seu perfil", settings: "Configurações" };
const enNames = { profile: "Your profile", settings: "Settings" };
const openSettings = async (page, names) => {
  await page.getByRole("button", { name: names.profile, exact: true }).click();
  await page
    .getByRole("menuitem", { name: names.settings, exact: true })
    .click();
};

test("Language starts from the browser locale, keeps untranslated copy English, and saves a choice", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  // The composer's chrome is translated; the field itself holds user text.
  const composer = page.getByRole("textbox", { name: "Mensagem em #Alpha" });
  await expect(composer).toBeVisible();
  expect(await lang(composer)).toBe("en");
  expect(
    await lang(page.locator('[data-placeholder="Mensagem em #Alpha"]')),
  ).toBe("pt-BR");
  expect(
    await lang(page.getByRole("button", { name: "Enviar mensagem" })),
  ).toBe("pt-BR");

  await openSettings(page, ptNames);
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
  const popup = page.getByRole("listbox");
  expect(
    await lang(popup.getByText("Idioma do aplicativo", { exact: true })),
  ).toBe("pt-BR");
  const english = popup.getByRole("option", {
    name: "English (United States)",
    exact: true,
  });
  expect(await lang(english)).toBe("en-US");
  expect(
    await lang(
      popup.getByRole("option", { name: "Português (Brasil)", exact: true }),
    ),
  ).toBe("pt-BR");
  await english.click();
  expect(
    await lang(
      page
        .getByRole("combobox", { name: "App language" })
        .getByText("English (United States)", { exact: true }),
    ),
  ).toBe("en-US");
  await expect(
    page.getByRole("region", { name: "Language", exact: true }),
  ).toBeVisible();

  // The saved choice outranks the browser's Portuguese preference.
  await page.reload();
  await openSettings(page, enNames);
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toHaveCount(1);
});

// Real Settings navigation and the host toast portal exercise lifecycle/focus
// boundaries that service tests and an isolated component cannot establish.
test("unsaved language recovery survives leaving Settings", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-language.v1", "en-US"),
  );
  await page.goto(app.origin);
  await openSettings(page, enNames);
  await selectSettingsSection(page, "Language");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "buzz-language.v1")
        throw new DOMException("denied", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("combobox", { name: "App language" }).click();
  await page
    .getByRole("option", { name: "Português (Brasil)", exact: true })
    .click();
  const notice = page.getByRole("dialog", {
    name: "O idioma não foi salvo",
    exact: true,
  });
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Voltar", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await openSettings(page, ptNames);
  await selectSettingsSection(page, "Idioma");
  await expect(notice).toBeVisible();
  await page.evaluate(() => window.restoreStorage());
  await notice
    .getByRole("button", { name: "Tentar salvar o idioma novamente" })
    .click();
  await expect(notice).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("buzz-language.v1")),
  ).toBe("pt-BR");
});
