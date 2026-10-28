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

const translations = [
  {
    tag: "pt-BR",
    name: "Português (Brasil)",
    language: "Idioma",
    appLanguage: "Idioma do aplicativo",
    back: "Voltar",
    app: "Aplicativo",
    unsaved: "O idioma não foi salvo",
    retry: "Tentar salvar o idioma novamente",
  },
  {
    tag: "zh-CN",
    name: "简体中文",
    language: "语言",
    appLanguage: "界面语言",
    back: "返回",
    app: "应用",
    unsaved: "语言设置未保存",
    retry: "重试保存语言设置",
  },
];

it.each(translations)(
  "translates host Settings labels and marks only them $tag",
  async (copy) => {
    document.documentElement.lang = "en";
    renderSettings();
    expect(screen.getByRole("button", { name: "Language" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await choose("App language", copy.name);

    const language = await screen.findByRole("button", { name: copy.language });
    expect(language).toHaveAttribute("aria-current", "page");
    expect(language).toHaveAttribute("lang", copy.tag);
    expect(screen.getByRole("button", { name: copy.back })).toHaveAttribute(
      "lang",
      copy.tag,
    );
    expect(screen.getByRole("heading", { name: copy.app })).toHaveAttribute(
      "lang",
      copy.tag,
    );
    expect(
      screen
        .getByRole("combobox", { name: copy.appLanguage })
        .closest("[lang]"),
    ).toHaveAttribute("lang", copy.tag);
    // Untranslated host copy keeps the document's English metadata.
    expect(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).not.toHaveAttribute("lang");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("buzz-language.v1")).toBe(copy.tag);
    expect(screen.queryByText(copy.unsaved)).not.toBeInTheDocument();
  },
);

it.each(translations)(
  "reports an unsaved $tag choice and retries",
  async (copy) => {
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
    await choose("App language", copy.name);

    const notice = await screen.findByText(copy.unsaved);
    expect(notice).toBeVisible();
    // The notice renders in the toast viewport, outside the section's `lang`.
    expect(notice.closest("[lang]")).toHaveAttribute("lang", copy.tag);
    expect(
      screen.getByRole("combobox", { name: copy.appLanguage }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Other page" }));
    view.rerender(settings(false));
    await expect.poll(() => screen.queryByText(copy.unsaved)).toBeNull();
    view.rerender(settings(true));
    expect(await screen.findByText(copy.unsaved)).toBeVisible();

    setItem.mockRestore();
    await user.click(screen.getByRole("button", { name: copy.retry }));
    await expect.poll(() => screen.queryByText(copy.unsaved)).toBeNull();
    expect(localStorage.getItem("buzz-language.v1")).toBe(copy.tag);
  },
);

it.each(translations)(
  "marks portaled $tag copy and language names with their own language",
  async (copy) => {
    document.documentElement.lang = "en";
    renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "App language" }));
    const translated = await screen.findByRole("option", {
      name: copy.name,
    });
    expect(translated.closest("[lang]")).toHaveAttribute("lang", copy.tag);
    await user.click(translated);
    expect(
      screen
        .getByRole("combobox", { name: copy.appLanguage })
        .querySelector(".buzz-select-value"),
    ).toHaveAttribute("lang", copy.tag);
    await user.click(screen.getByRole("combobox", { name: copy.appLanguage }));
    const english = await screen.findByRole("option", {
      name: "English (United States)",
    });
    expect(english.closest("[lang]")).toHaveAttribute("lang", "en-US");
    expect(english.closest(".buzz-select-popup")).toHaveAttribute(
      "lang",
      copy.tag,
    );
    await user.click(english);
    expect(
      screen
        .getByRole("combobox", { name: "App language" })
        .querySelector(".buzz-select-value"),
    ).toHaveAttribute("lang", "en-US");
  },
);
