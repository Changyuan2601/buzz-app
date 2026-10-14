// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { type Catalogue, enUS } from "./catalogues/en-US";
import { locales } from "./locales";
import { createLocalization, LANGUAGE_KEY } from "./service";

afterEach(() => {
  localStorage.clear();
});

const host = (languages: readonly string[], storage: Storage = localStorage) =>
  ({
    navigator: { languages },
    localStorage: storage,
    addEventListener: window.addEventListener.bind(window),
  }) as unknown as Window;

it("starts in the first supported system language", () => {
  const { i18n, current } = createLocalization(host(["fr-FR", "pt-BR"]));
  expect(current()).toBe("pt-BR");
  expect(i18n.t("settings.title")).toBe("Configurações");
});

it("starts in the saved language over the system language", () => {
  localStorage.setItem(LANGUAGE_KEY, "en-US");
  expect(createLocalization(host(["pt-BR"])).current()).toBe("en-US");
});

it("saves a choice and follows changes made in another window", async () => {
  const localization = createLocalization(host(["en-US"]));
  expect(await localization.setLocale("pt-BR")).toBe(true);
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe("pt-BR");

  localStorage.setItem(LANGUAGE_KEY, "en-US");
  window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_KEY }));
  await expect.poll(localization.current).toBe("en-US");
});

it("keeps the document's language metadata while switching", async () => {
  document.documentElement.lang = "en";
  await createLocalization(host(["en-US"])).setLocale("pt-BR");
  expect(document.documentElement.lang).toBe("en");
});

it("applies an unsaved choice for this session when storage fails", async () => {
  const failing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  const localization = createLocalization(host(["en-US"], failing));
  expect(localization.current()).toBe("en-US");
  expect(await localization.setLocale("pt-BR")).toBe(false);
  expect(localization.current()).toBe("pt-BR");
});

it("falls back to English for a message a catalogue lacks", async () => {
  // Without "settings.back"; a stale catalogue must not show raw keys.
  const partial = Object.fromEntries([
    ...Object.entries(enUS).filter(([key]) => key !== "settings.back"),
    ["settings.title", "Paramètres"],
  ]) as unknown as Catalogue;
  const localization = createLocalization(host(["fr-FR"]), [
    ...locales,
    {
      tag: "fr-FR",
      name: "Français (France)",
      catalogue: partial,
    },
  ]);
  expect(localization.current()).toBe("fr-FR");
  expect(localization.i18n.t("settings.title")).toBe("Paramètres");
  expect(localization.i18n.t("settings.back")).toBe("Back");
});

it("rejects a locale that is not registered", async () => {
  const localization = createLocalization(host(["en-US"]));
  await expect(localization.setLocale("fr-FR")).rejects.toThrow(
    "Unsupported locale",
  );
  expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull();
});
