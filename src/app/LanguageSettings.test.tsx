// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageSettings } from "./LanguageSettings";
import { SettingsSidebar } from "./SettingsSidebar";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";
import { localization } from "../features/localization/service";
import { ToastProvider } from "../shared/design-system/ui/Toast";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await localization.setLocale("en-US");
  localStorage.clear();
});

const client = { selected: null, memberships: [] };
const connection = { scope: "language-settings-test" };
const cards: ReturnType<SettingsCards["snapshot"]> = [];
const renderSettings = () =>
  render(
    <ToastProvider>
      <SettingsSidebar
        communities={
          {
            subscribe: () => () => {},
            snapshot: () => client,
            relay: {
              subscribe: () => () => {},
              snapshot: () => connection,
            },
          } as unknown as Communities
        }
        cards={
          {
            subscribe: () => () => {},
            snapshot: () => cards,
          } as unknown as SettingsCards
        }
        selected="language"
        onBack={() => {}}
        onSection={() => {}}
      />
      <LanguageSettings />
    </ToastProvider>,
  );

const choose = async (label: string, option: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
};

it("translates host Settings labels and marks only them Portuguese", async () => {
  document.documentElement.lang = "en";
  renderSettings();
  expect(screen.getByRole("button", { name: "Language" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await choose("App language", "Português (Brasil)");

  const language = await screen.findByRole("button", { name: "Idioma" });
  expect(language).toHaveAttribute("aria-current", "page");
  expect(language).toHaveAttribute("lang", "pt-BR");
  expect(screen.getByRole("button", { name: "Voltar" })).toHaveAttribute(
    "lang",
    "pt-BR",
  );
  expect(screen.getByRole("heading", { name: "Aplicativo" })).toHaveAttribute(
    "lang",
    "pt-BR",
  );
  expect(
    screen
      .getByRole("combobox", { name: "Idioma do aplicativo" })
      .closest("[lang]"),
  ).toHaveAttribute("lang", "pt-BR");
  // Untranslated host copy keeps the document's English metadata.
  expect(
    screen.getByRole("navigation", { name: "Settings sections" }),
  ).not.toHaveAttribute("lang");
  expect(document.documentElement.lang).toBe("en");
  expect(localStorage.getItem("buzz-language.v1")).toBe("pt-BR");
  expect(screen.queryByText("O idioma não foi salvo")).not.toBeInTheDocument();
});

it("reports a language that is active but unsaved, and retries", async () => {
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  renderSettings();
  await choose("App language", "Português (Brasil)");

  const notice = await screen.findByText("O idioma não foi salvo");
  expect(notice).toBeVisible();
  // The notice renders in the toast viewport, outside the section's `lang`.
  expect(notice.closest("[lang]")).toHaveAttribute("lang", "pt-BR");
  expect(screen.getByRole("button", { name: "Idioma" })).toBeVisible();

  setItem.mockRestore();
  await userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: "Tentar salvar o idioma novamente" }),
    );
  await expect
    .poll(() => screen.queryByText("O idioma não foi salvo"))
    .toBeNull();
  expect(localStorage.getItem("buzz-language.v1")).toBe("pt-BR");
});
