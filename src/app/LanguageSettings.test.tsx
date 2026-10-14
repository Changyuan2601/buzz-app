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
  localization.setLocale("en-US");
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
  const user = userEvent.setup();
  const settings = (open: boolean) => (
    <ToastProvider>
      <button type="button">Other page</button>
      {open && <LanguageSettings />}
    </ToastProvider>
  );
  const view = render(settings(true));
  await choose("App language", "Português (Brasil)");

  const notice = await screen.findByText("O idioma não foi salvo");
  expect(notice).toBeVisible();
  // The notice renders in the toast viewport, outside the section's `lang`.
  expect(notice.closest("[lang]")).toHaveAttribute("lang", "pt-BR");
  expect(
    screen.getByRole("combobox", { name: "Idioma do aplicativo" }),
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Other page" }));
  view.rerender(settings(false));
  await expect
    .poll(() => screen.queryByText("O idioma não foi salvo"))
    .toBeNull();
  view.rerender(settings(true));
  expect(await screen.findByText("O idioma não foi salvo")).toBeVisible();

  setItem.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Tentar salvar o idioma novamente" }),
  );
  await expect
    .poll(() => screen.queryByText("O idioma não foi salvo"))
    .toBeNull();
  expect(localStorage.getItem("buzz-language.v1")).toBe("pt-BR");
});

it("marks portaled picker copy and each language name with their own language", async () => {
  document.documentElement.lang = "en";
  renderSettings();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "App language" }));
  const portuguese = await screen.findByRole("option", {
    name: "Português (Brasil)",
  });
  expect(portuguese.closest("[lang]")).toHaveAttribute("lang", "pt-BR");
  await user.click(portuguese);
  expect(
    screen
      .getByRole("combobox", { name: "Idioma do aplicativo" })
      .querySelector(".buzz-select-value"),
  ).toHaveAttribute("lang", "pt-BR");
  await user.click(
    screen.getByRole("combobox", { name: "Idioma do aplicativo" }),
  );
  const english = await screen.findByRole("option", {
    name: "English (United States)",
  });
  expect(english.closest("[lang]")).toHaveAttribute("lang", "en-US");
  expect(english.closest(".buzz-select-popup")).toHaveAttribute(
    "lang",
    "pt-BR",
  );
  await user.click(english);
  expect(
    screen
      .getByRole("combobox", { name: "App language" })
      .querySelector(".buzz-select-value"),
  ).toHaveAttribute("lang", "en-US");
});
